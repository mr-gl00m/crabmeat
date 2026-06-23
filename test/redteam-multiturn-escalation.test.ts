/**
 * Red Team Security Tests — Multi-Turn Capability Escalation
 *
 * The architectural claim CrabMeat makes is that the prompt boundary is the
 * *model's* boundary, not the security boundary. Prompt injection is assumed
 * to win at the LLM layer — the question is what a fully-compromised model can
 * actually *do*, and the answer is supposed to be "nothing outside the effect
 * classes the agent was provisioned with before the session started."
 *
 * The existing single-shot tests (src/agents/tools/capability-wall.test.ts)
 * prove the deterministic gate (validateToolInvocation) rejects an escalation
 * *once*. They do NOT prove the gate stays rejecting under the failure mode a
 * critic actually reaches for: the slow-boil, scripted multi-turn chain that
 * builds legitimate trust over many turns and then tries to escalate — betting
 * that accumulated context erodes the boundary.
 *
 * These tests close that gap. They drive the REAL validation gate across
 * scripted N-turn attack chains against ONE persistent security context and
 * assert the load-bearing invariant:
 *
 *   The gate's verdict for an invocation is a pure function of (capability id,
 *   agent grant, tool definition). It does not depend on conversation length,
 *   prior successes, or how much benign traffic preceded the attack.
 *
 * Vectors exercised across turns:
 *   - graduated "boiling-frog" effect-class escalation (read → … → privileged)
 *   - verdict invariance: same attack at turn 1 == turn 40
 *   - security-context immutability: the chain never mutates capMap / grant
 *   - cross-session capability-ID replay (another session's caps are dead here)
 *   - forged / guessed capability IDs interleaved with real traffic
 *   - schema-smuggling on a granted tool (never reaches execution)
 *   - owner-only crafted-cap invocation by a non-owner caller
 *   - audit completeness + hash-chain integrity over the whole chain
 *
 * If any of these regress, "we moved the trust boundary below the prompt" stops
 * being true.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { validateToolInvocation } from "../src/agents/tools/validate.js";
import { createToolCatalog, type ToolCatalog } from "../src/agents/tools/catalog.js";
import { createAuditLog, type AuditLog } from "../src/security/audit.js";
import { EffectDeniedError, ToolValidationError } from "../src/infra/errors.js";
import {
  OWNER_ONLY_TOOL_NAMES,
  isOwnerOnlyToolName,
  type CallerRole,
} from "../src/security/owner-only-tools.js";
import type {
  ToolInvocation,
  CapabilityMap,
  ToolDefinition,
  EffectClass,
} from "../src/agents/tools/types.js";
import type { AgentConfig, Config } from "../src/config/types.js";

// ── Synthetic world ──────────────────────────────────────────────
//
// We use synthetic tool configs rather than the live builtin catalog so the
// suite is isolated from catalog drift (new builtins, renamed effect classes).
// The same five effect classes the runtime ships are represented, plus a
// network tool the attacked agent is NOT granted at all (allowlist gate) and a
// fixed timestamp so audit entries are deterministic.

const FIXED_TS = "2026-05-28T00:00:00.000Z";

function mkTool(id: string, effectClass: EffectClass): NonNullable<Config["tools"]>[number] {
  return {
    id,
    name: id,
    description: `${id} tool`,
    effectClass,
    parameters: {
      input: { type: "string", description: "input", required: true, secretRef: false },
    },
    outputs: {},
  } as NonNullable<Config["tools"]>[number];
}

function makeConfig(): Config {
  return {
    tools: [
      mkTool("notes_read", "read"),
      mkTool("notes_write", "write"),
      mkTool("shell_exec", "exec"),
      mkTool("http_get", "network"),
      mkTool("sys_admin", "privileged"),
      // In the catalog but deliberately NOT in the agent's grant — the
      // allowlist gate (step 2) must reject it before effect class is even read.
      mkTool("secret_exfil", "network"),
    ],
  } as unknown as Config;
}

/**
 * The attacked agent: a read-only assistant whose config declares the
 * high-impact tools in `tools` (so they're "wired") but grants only the `read`
 * effect class. This is the defense-in-depth case that matters — the model can
 * emit a write/exec/network/privileged call (or craft its cap id), and the
 * deterministic gate still refuses the *effect*, not just the name.
 */
function makeReadOnlyAgent(): AgentConfig {
  return {
    id: "assistant",
    model: "test-model",
    systemPrompt: "read-only assistant",
    tools: ["notes_read", "notes_write", "shell_exec", "http_get", "sys_admin"],
    allowedEffects: ["read"],
  } as unknown as AgentConfig;
}

// ── Attack-chain harness ─────────────────────────────────────────

type Verdict =
  | "allowed"
  | "denied-effect" // tool granted, effect class not in allowedEffects
  | "denied-tool" // tool not in agent's allowlist
  | "denied-unknown" // capability id does not resolve (forged / cross-session)
  | "denied-owner" // owner-only tool, non-owner caller
  | "invalid-args"; // resolved + permitted, but parameters failed schema

interface AttackContext {
  agent: AgentConfig;
  capMap: CapabilityMap;
  catalog: ToolCatalog;
  audit: AuditLog;
  sessionKey: string;
  /** Grows by one each turn — the harness's stand-in for accumulated context. */
  turn: number;
}

function makeContext(overrides: Partial<AttackContext> = {}): AttackContext {
  const catalog = overrides.catalog ?? createToolCatalog(makeConfig(), "test-secret");
  const sessionKey = overrides.sessionKey ?? "attacked-session";
  return {
    agent: overrides.agent ?? makeReadOnlyAgent(),
    catalog,
    sessionKey,
    capMap: overrides.capMap ?? catalog.mintCapabilityMap(sessionKey),
    audit: overrides.audit ?? createAuditLog(),
    turn: 0,
  };
}

/** Resolve the live capability id for a tool id within a session's cap map. */
function capIdFor(capMap: CapabilityMap, toolId: string): string {
  for (const [capId, id] of capMap) if (id === toolId) return capId;
  throw new Error(`no capability id minted for '${toolId}'`);
}

/**
 * Run one turn through the REAL gate, classify the outcome, and write an audit
 * entry the same way the inference loop's deny path does (success → "success";
 * effect/owner/allowlist denial → "denied"; validation rejection → "error").
 * The handler is never invoked — a denied or malformed call must produce no
 * effect, so there is nothing to execute.
 */
function step(ctx: AttackContext, invocation: ToolInvocation, callerRole: CallerRole = "owner"): Verdict {
  ctx.turn += 1;
  const resolvedToolId = ctx.catalog.resolveCapability(invocation.capabilityId, ctx.capMap);

  try {
    const validated = validateToolInvocation(
      invocation,
      ctx.agent,
      ctx.capMap,
      ctx.catalog,
      callerRole,
    );
    ctx.audit.record({
      timestamp: FIXED_TS,
      sessionKey: ctx.sessionKey,
      toolId: validated.toolId,
      toolName: validated.toolName,
      effectClass: validated.effectClass,
      callId: invocation.callId,
      parameters: invocation.arguments,
      resultStatus: "success",
      durationMs: 0,
      callerRole,
    });
    return "allowed";
  } catch (err) {
    let verdict: Verdict;
    let resultStatus: "denied" | "error";
    if (err instanceof EffectDeniedError) {
      resultStatus = "denied";
      if (/owner-only/.test(err.message)) verdict = "denied-owner";
      else if (/Effect class/.test(err.message)) verdict = "denied-effect";
      else verdict = "denied-tool";
    } else if (err instanceof ToolValidationError) {
      resultStatus = "error";
      verdict = /Unknown capability/.test(err.message) ? "denied-unknown" : "invalid-args";
    } else {
      throw err;
    }
    ctx.audit.record({
      timestamp: FIXED_TS,
      sessionKey: ctx.sessionKey,
      toolId: resolvedToolId ?? invocation.capabilityId,
      toolName: resolvedToolId ?? "<unresolved>",
      effectClass: "read",
      callId: invocation.callId,
      parameters: invocation.arguments,
      resultStatus,
      durationMs: 0,
      callerRole,
    });
    return verdict;
  }
}

/** A benign, always-allowed read call — the trust-building filler between attacks. */
function benignRead(ctx: AttackContext): ToolInvocation {
  return {
    capabilityId: capIdFor(ctx.capMap, "notes_read"),
    callId: `read-${ctx.turn}`,
    arguments: { input: "what's on my calendar?" },
  };
}

// ── RT-MT-001: graduated "boiling-frog" escalation ───────────────

describe("RT-MT-001: trust built over benign turns does not unlock effect classes", () => {
  it("each escalation step beyond the grant is denied on its merits, mid-chain", () => {
    const ctx = makeContext();

    // 10 turns of legitimate read traffic — establish the "trusted" history an
    // attacker would lean on.
    for (let i = 0; i < 10; i++) {
      expect(step(ctx, benignRead(ctx))).toBe("allowed");
    }

    // Now ramp the effect class. Every one of these tools is in the agent's
    // `tools` list, so a compromised model could legitimately emit the call —
    // the gate refuses the effect, not the name.
    const ramp: Array<[string, Verdict]> = [
      ["notes_write", "denied-effect"],
      ["shell_exec", "denied-effect"],
      ["http_get", "denied-effect"],
      ["sys_admin", "denied-effect"],
    ];
    for (const [toolId, expected] of ramp) {
      const verdict = step(ctx, {
        capabilityId: capIdFor(ctx.capMap, toolId),
        callId: `escalate-${toolId}`,
        arguments: { input: "now do the privileged thing" },
      });
      expect(verdict).toBe(expected);
    }

    // Read access still works afterward — denial doesn't wedge the session.
    expect(step(ctx, benignRead(ctx))).toBe("allowed");
  });

  it("a tool entirely outside the grant hits the allowlist gate, not the effect gate", () => {
    const ctx = makeContext();
    for (let i = 0; i < 5; i++) step(ctx, benignRead(ctx));

    const verdict = step(ctx, {
      capabilityId: capIdFor(ctx.capMap, "secret_exfil"),
      callId: "exfil-attempt",
      arguments: { input: "ship the .env" },
    });
    expect(verdict).toBe("denied-tool");
  });
});

// ── RT-MT-002: verdict invariance across turn position ───────────

describe("RT-MT-002: identical escalation gets identical verdict regardless of turn position", () => {
  it("the same write attempt at turn 1 and turn 40 throws the same error", () => {
    const ctx = makeContext();
    const writeAttempt = (): ToolInvocation => ({
      capabilityId: capIdFor(ctx.capMap, "notes_write"),
      callId: `write-${ctx.turn}`,
      arguments: { input: "persist this" },
    });

    // Capture the exact rejection at the very start of the session.
    let earlyMessage = "";
    try {
      validateToolInvocation(writeAttempt(), ctx.agent, ctx.capMap, ctx.catalog, "owner");
    } catch (err) {
      earlyMessage = (err as Error).message;
    }
    expect(earlyMessage).toMatch(/Effect class 'write' is not permitted/);

    // Bury it under 40 turns of benign traffic.
    for (let i = 0; i < 40; i++) step(ctx, benignRead(ctx));

    let lateMessage = "";
    try {
      validateToolInvocation(writeAttempt(), ctx.agent, ctx.capMap, ctx.catalog, "owner");
    } catch (err) {
      lateMessage = (err as Error).message;
    }

    // Byte-identical rejection. Context length is not an input to the gate.
    expect(lateMessage).toBe(earlyMessage);
  });
});

// ── RT-MT-003: security-context immutability ─────────────────────

describe("RT-MT-003: a full attack chain never mutates the security context", () => {
  it("capMap entries and the agent grant are byte-identical before and after", () => {
    const ctx = makeContext();
    const capMapBefore = JSON.stringify([...ctx.capMap.entries()].sort());
    const agentBefore = JSON.stringify(ctx.agent);

    // 50 mixed turns: benign reads interleaved with every escalation vector.
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        step(ctx, benignRead(ctx));
      } else {
        const toolId = ["notes_write", "shell_exec", "http_get", "sys_admin"][i % 4]!;
        step(ctx, {
          capabilityId: capIdFor(ctx.capMap, toolId),
          callId: `mix-${i}`,
          arguments: { input: "x" },
        });
      }
    }

    expect(JSON.stringify([...ctx.capMap.entries()].sort())).toBe(capMapBefore);
    expect(JSON.stringify(ctx.agent)).toBe(agentBefore);
  });
});

// ── RT-MT-004: cross-session capability-ID replay ────────────────

describe("RT-MT-004: capability IDs harvested from another session are dead here", () => {
  it("a cap ID minted for a different session never resolves in the attacked session", () => {
    // Shared catalog (same deployment secret), two sessions. The attacker has
    // 'seen' session-victim's transcript and replays its capability ids.
    const catalog = createToolCatalog(makeConfig(), "test-secret");
    const attacked = makeContext({ catalog, sessionKey: "attacked-session" });
    const victimCapMap = catalog.mintCapabilityMap("victim-session");

    // The same tool has a DIFFERENT cap id per session (HMAC binds sessionKey).
    const victimReadCap = capIdFor(victimCapMap, "notes_read");
    const attackedReadCap = capIdFor(attacked.capMap, "notes_read");
    expect(victimReadCap).not.toBe(attackedReadCap);

    // Replay victim caps across a chain — even the read cap, which would be
    // allowed if it belonged to this session, is unknown here.
    for (const toolId of ["notes_read", "notes_write", "sys_admin"]) {
      const verdict = step(attacked, {
        capabilityId: capIdFor(victimCapMap, toolId),
        callId: `replay-${toolId}`,
        arguments: { input: "borrowed capability" },
      });
      expect(verdict).toBe("denied-unknown");
    }
  });
});

// ── RT-MT-005: forged / guessed capability IDs ───────────────────

describe("RT-MT-005: forged capability IDs interleaved with real traffic are always denied", () => {
  it("guessed cap_* tokens never resolve, no matter the surrounding context", () => {
    const ctx = makeContext();
    const forgeries = [
      "cap_000000000000",
      "cap_deadbeefcafe",
      "cap_ffffffffffff",
      "notes_read", // raw tool id, betting the gate matches on names
      "cap_", // truncated
    ];

    for (let i = 0; i < forgeries.length; i++) {
      // Sandwich each forgery between legitimate reads.
      expect(step(ctx, benignRead(ctx))).toBe("allowed");
      const verdict = step(ctx, {
        capabilityId: forgeries[i]!,
        callId: `forge-${i}`,
        arguments: { input: "x" },
      });
      expect(verdict).toBe("denied-unknown");
    }
  });
});

// ── RT-MT-006: schema-smuggling on a granted tool ────────────────

describe("RT-MT-006: malformed arguments on a granted tool are rejected before execution", () => {
  it("a permitted read call with bad parameters fails the schema gate across turns", () => {
    const ctx = makeContext();
    const readCap = capIdFor(ctx.capMap, "notes_read");

    const malformed: Array<Record<string, unknown>> = [
      {}, // missing required `input`
      { input: 42 }, // wrong type
      { input: null }, // null where string required
      { wrong_field: "x" }, // required field absent, extra present
    ];

    for (let i = 0; i < malformed.length; i++) {
      // Prove the cap itself is good by succeeding with valid args first.
      expect(
        step(ctx, { capabilityId: readCap, callId: `ok-${i}`, arguments: { input: "fine" } }),
      ).toBe("allowed");

      const verdict = step(ctx, {
        capabilityId: readCap,
        callId: `bad-${i}`,
        arguments: malformed[i]!,
      });
      expect(verdict).toBe("invalid-args");
    }
  });
});

// ── RT-MT-007: owner-only crafted capability ─────────────────────
//
// OWNER_ONLY_TOOL_NAMES ships empty (no owner-gated tool exists yet), so the
// real catalog can't mark a tool ownerOnly. We drive the gate's owner-only
// branch with a hand-built catalog whose tool definition sets ownerOnly:true —
// this is exactly the "caller crafts a raw capability id" case the branch's
// own comment in validate.ts describes, proven to deny a non-owner caller even
// after a long benign chain.
//
// The REAL createToolCatalog → validate wiring for owner-only tools is
// contract-tested in RT-MT-009 below, which goes live automatically the moment
// the first owner-only tool is added to the registry — at which point this
// synthetic stand-in can be retired.

function ownerOnlyCatalog(): { catalog: ToolCatalog; capMap: CapabilityMap } {
  const toolDef: ToolDefinition = {
    id: "sys_admin",
    name: "sys_admin",
    description: "owner-gated admin tool",
    parameters: { input: { type: "string", required: true, secretRef: false } },
    outputs: {},
    effectClass: "privileged",
    parameterSchema: z.object({ input: z.string() }),
    ownerOnly: true,
  };
  const capId = "cap_owneradmin01";
  const capMap: CapabilityMap = new Map([[capId, "sys_admin"]]);
  const catalog: ToolCatalog = {
    size: 1,
    get: (id) => (id === "sys_admin" ? toolDef : undefined),
    getAvailableTools: () => [toolDef],
    mintCapabilityMap: () => capMap,
    getToolDeclarations: () => [],
    resolveCapability: (c, m) => m.get(c),
  };
  return { catalog, capMap };
}

describe("RT-MT-007: owner-only tool denies a non-owner caller even after benign turns", () => {
  it("a crafted owner-only cap from an 'external' caller is denied; an owner is allowed", () => {
    const { catalog, capMap } = ownerOnlyCatalog();
    // Agent grants the tool and the privileged effect — so the ONLY thing left
    // standing between an external caller and the privileged tool is the
    // owner-only gate (validate step 4).
    const agent = {
      id: "assistant",
      model: "m",
      systemPrompt: "s",
      tools: ["sys_admin"],
      allowedEffects: ["privileged"],
    } as unknown as AgentConfig;
    const ctx = makeContext({ catalog, capMap, agent });

    const adminCap = capIdFor(capMap, "sys_admin");
    const invoke = (role: CallerRole, n: number): Verdict =>
      step(
        ctx,
        { capabilityId: adminCap, callId: `admin-${n}`, arguments: { input: "rm -rf" } },
        role,
      );

    // Owner can use it — establishes that everything BUT the role check passes.
    expect(invoke("owner", 0)).toBe("allowed");

    // A non-owner ("external" = inbound webhook / unverified sender) is denied,
    // and stays denied after a stretch of owner activity in the same session.
    expect(invoke("external", 1)).toBe("denied-owner");
    for (let i = 0; i < 20; i++) invoke("owner", 100 + i);
    expect(invoke("external", 2)).toBe("denied-owner");
    expect(invoke("shell", 3)).toBe("denied-owner");
  });
});

// ── RT-MT-008: audit completeness + hash-chain integrity ─────────

describe("RT-MT-008: every turn is on the receipt chain and no escalation logs as success", () => {
  let ctx: AttackContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it("a scripted 60-turn mixed chain records one tamper-evident entry per turn", () => {
    // Deterministic script: 2 of every 3 turns benign, the third an escalation
    // drawn round-robin from the vectors above.
    const escalations: Array<() => ToolInvocation> = [
      () => ({ capabilityId: capIdFor(ctx.capMap, "notes_write"), callId: `e-w-${ctx.turn}`, arguments: { input: "x" } }),
      () => ({ capabilityId: capIdFor(ctx.capMap, "sys_admin"), callId: `e-a-${ctx.turn}`, arguments: { input: "x" } }),
      () => ({ capabilityId: "cap_deadbeefcafe", callId: `e-f-${ctx.turn}`, arguments: { input: "x" } }),
      () => ({ capabilityId: capIdFor(ctx.capMap, "secret_exfil"), callId: `e-x-${ctx.turn}`, arguments: { input: "x" } }),
    ];

    let allowed = 0;
    let escalated = 0;
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 2) {
        const verdict = step(ctx, escalations[(escalated % escalations.length)]!());
        expect(verdict).not.toBe("allowed");
        escalated += 1;
      } else {
        expect(step(ctx, benignRead(ctx))).toBe("allowed");
        allowed += 1;
      }
    }

    const entries = ctx.audit.getEntries(ctx.sessionKey);
    expect(entries.length).toBe(60);

    // The chain is tamper-evident and intact end to end.
    expect(ctx.audit.verify().valid).toBe(true);

    // Exactly the benign reads are "success"; nothing else slipped through.
    const successes = entries.filter((e) => e.resultStatus === "success");
    expect(successes.length).toBe(allowed);
    expect(successes.every((e) => e.toolId === "notes_read")).toBe(true);

    // Every escalation is recorded as a non-effect (denied or error) — the
    // attack is on the record, and the record says it never ran.
    const nonSuccess = entries.filter((e) => e.resultStatus !== "success");
    expect(nonSuccess.length).toBe(escalated);
    expect(nonSuccess.every((e) => e.toolId !== "notes_read")).toBe(true);
  });

  it("the receipt chain detects after-the-fact tampering with a recorded escalation", () => {
    step(ctx, benignRead(ctx));
    step(ctx, {
      capabilityId: capIdFor(ctx.capMap, "sys_admin"),
      callId: "tamper-target",
      arguments: { input: "x" },
    });
    step(ctx, benignRead(ctx));

    expect(ctx.audit.verify().valid).toBe(true);

    // Simulate an attacker editing the log to relabel the denied privileged
    // call as a success. getEntries() returns the live entries; mutate one and
    // the hash chain must break.
    const entries = ctx.audit.getEntries(ctx.sessionKey);
    const target = entries.find((e) => e.callId === "tamper-target")!;
    (target as { resultStatus: string }).resultStatus = "success";

    const result = ctx.audit.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(target.seq);
  });
});

// ── RT-MT-009: owner-only gate is registry-driven + wiring contract ──
//
// RT-MT-007 proves the owner-only ENFORCEMENT branch (validate.ts step 4) with
// a synthetic catalog. These tests cover the rest of the owner-only path as it
// actually ships: the gate is selective (a non-owner can use a non-gated tool),
// the flag is driven by the real registry, and a self-promoting contract test
// exercises the live createToolCatalog → validate path for every registered
// owner-only tool — currently none, by design.

describe("RT-MT-009: owner-only gate is registry-driven, and wiring is contract-tested", () => {
  it("a non-owner caller CAN use a tool that is not owner-only (the gate is selective, not a blanket block)", () => {
    const catalog = createToolCatalog(makeConfig(), "test-secret");
    // notes_read is not in the owner-only registry → the catalog marks it non-owner.
    expect(catalog.get("notes_read")?.ownerOnly ?? false).toBe(false);

    const agent = makeReadOnlyAgent();
    const capMap = catalog.mintCapabilityMap("sess-extern");
    const readCap = capIdFor(capMap, "notes_read");

    // An "external" (non-owner) caller passes — owner-only gating only fires for
    // registry-listed tools, so non-owners aren't blanket-denied everything.
    const validated = validateToolInvocation(
      { capabilityId: readCap, callId: "c1", arguments: { input: "hi" } },
      agent,
      capMap,
      catalog,
      "external",
    );
    expect(validated.toolId).toBe("notes_read");
  });

  it("isOwnerOnlyToolName discriminates (negative case holds while the registry is empty)", () => {
    expect(isOwnerOnlyToolName("definitely_not_owner_only")).toBe(false);
  });

  it("CONTRACT: every shipped owner-only tool is flagged by the real catalog and denied to non-owners", () => {
    // OWNER_ONLY_TOOL_NAMES ships empty by design, so this iterates zero times
    // today. It is the self-promoting check: the moment a real owner-only tool
    // is registered, this exercises the live createToolCatalog → validate path
    // for it, and the synthetic stand-in in RT-MT-007 can be retired.
    for (const toolId of OWNER_ONLY_TOOL_NAMES) {
      const config = { tools: [mkTool(toolId, "privileged")] } as unknown as Config;
      const catalog = createToolCatalog(config, "test-secret");
      // The real catalog must mark a registry-listed tool ownerOnly.
      expect(catalog.get(toolId)?.ownerOnly).toBe(true);

      const agent = {
        id: "a",
        model: "m",
        systemPrompt: "s",
        tools: [toolId],
        allowedEffects: ["privileged"],
      } as unknown as AgentConfig;
      const capMap = catalog.mintCapabilityMap("sess-owner-contract");
      const cap = capIdFor(capMap, toolId);

      // Effect + allowlist pass; the owner-only gate is the only thing that fires.
      expect(() =>
        validateToolInvocation(
          { capabilityId: cap, callId: "c1", arguments: { input: "x" } },
          agent,
          capMap,
          catalog,
          "external",
        ),
      ).toThrow(/owner-only/);
    }
  });
});
