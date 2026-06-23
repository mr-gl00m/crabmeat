/**
 * Owner-only tool routing — Phase 4.11.
 *
 * The invariant: tools that mutate config or restart the gateway must
 * be reachable only by callers with role "owner". Hermes
 * (callerRole: "shell") and webhooks (callerRole: "external") arriving
 * in later phases must hit a closed door, both at the catalog surface
 * (no declarations leak) and at the validate gate (a forged capability
 * id still gets rejected).
 *
 * OWNER_ONLY_TOOL_NAMES ships empty in current crabmeat — there's no
 * config-mutating or restart tool yet. So this suite mutates a fixture
 * tool's ownerOnly flag in the live catalog after construction. Same
 * shape as production: catalog.get returns ToolDefinition references,
 * not copies, so flipping ownerOnly mid-test simulates a future tool
 * that opted into the registry without polluting the real list.
 */

import { describe, it, expect, vi } from "vitest";
import { validateToolInvocation } from "./validate.js";
import { createToolCatalog } from "./catalog.js";
import { createAuditLog } from "../../security/audit.js";
import { EffectDeniedError } from "../../infra/errors.js";
import type { AgentConfig, Config } from "../../config/types.js";
import type { ToolInvocation } from "./types.js";
import type { CallerRole } from "../../security/owner-only-tools.js";

function makeConfig(): Config {
  return {
    agents: [
      {
        id: "test-agent",
        name: "Test",
        systemPrompt: "test",
        tools: ["read_tool", "owner_tool"],
        allowedEffects: ["read", "write"],
      },
    ],
    tools: [
      {
        id: "read_tool",
        name: "read_tool",
        description: "ordinary read tool",
        effectClass: "read",
        parameters: {
          q: { type: "string", description: "q", required: true, secretRef: false },
        },
        outputs: {},
      },
      {
        id: "owner_tool",
        name: "owner_tool",
        description: "fixture: simulates a future config-mutating tool",
        effectClass: "write",
        parameters: {
          q: { type: "string", description: "q", required: true, secretRef: false },
        },
        outputs: {},
      },
    ],
  } as unknown as Config;
}

function makeAgent(): AgentConfig {
  return {
    id: "test-agent",
    name: "Test",
    systemPrompt: "test",
    tools: ["read_tool", "owner_tool"],
    allowedEffects: ["read", "write"],
  } as AgentConfig;
}

function capIdFor(
  catalog: ReturnType<typeof createToolCatalog>,
  sessionKey: string,
  toolId: string,
): string {
  const capMap = catalog.mintCapabilityMap(sessionKey);
  for (const [capId, tid] of capMap) {
    if (tid === toolId) return capId;
  }
  throw new Error(`No cap id for ${toolId}`);
}

function buildCatalogWithOwnerOnly(): ReturnType<typeof createToolCatalog> {
  const config = makeConfig();
  const catalog = createToolCatalog(config, "test-secret");
  // Flip the fixture tool's ownerOnly flag — same effect as if its id had
  // been in OWNER_ONLY_TOOL_NAMES at construction time. ToolDefinition's
  // ownerOnly is optional+mutable on purpose so future tools can opt in
  // structurally; this is also the test handle.
  const ownerTool = catalog.get("owner_tool");
  if (!ownerTool) throw new Error("fixture missing");
  ownerTool.ownerOnly = true;
  return catalog;
}

describe("owner-only routing — catalog filtering", () => {
  it("owner caller sees both tools in declarations", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s-owner");

    const decls = catalog.getToolDeclarations(agent, capMap, "owner");
    const tools = catalog.getAvailableTools(agent, "owner");

    expect(decls.length).toBe(2);
    expect(tools.map((t) => t.id).sort()).toEqual(["owner_tool", "read_tool"]);
  });

  it("absent callerRole defaults to owner — preserves legacy behavior", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s-legacy");

    const decls = catalog.getToolDeclarations(agent, capMap);
    const tools = catalog.getAvailableTools(agent);

    expect(decls.length).toBe(2);
    expect(tools.length).toBe(2);
  });

  it("shell caller sees only the non-owner-only tool", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s-shell");

    const tools = catalog.getAvailableTools(agent, "shell");
    const decls = catalog.getToolDeclarations(agent, capMap, "shell");

    expect(tools.map((t) => t.id)).toEqual(["read_tool"]);
    expect(decls.length).toBe(1);
  });

  it("external caller sees only the non-owner-only tool", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s-external");

    const tools = catalog.getAvailableTools(agent, "external");
    expect(tools.map((t) => t.id)).toEqual(["read_tool"]);
  });
});

describe("owner-only routing — validate-time gate", () => {
  it("owner caller can validate an owner-only tool", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s1");
    const capId = capIdFor(catalog, "s1", "owner_tool");
    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "c1",
      arguments: { q: "go" },
    };
    const result = validateToolInvocation(invocation, agent, capMap, catalog, "owner");
    expect(result.toolId).toBe("owner_tool");
  });

  it("shell caller is rejected with EffectDeniedError on owner-only tool", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s2");
    const capId = capIdFor(catalog, "s2", "owner_tool");
    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "c2",
      arguments: { q: "go" },
    };
    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog, "shell"),
    ).toThrow(EffectDeniedError);
    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog, "shell"),
    ).toThrow(/owner-only.*'shell'/);
  });

  it("external caller is rejected with EffectDeniedError on owner-only tool", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s3");
    const capId = capIdFor(catalog, "s3", "owner_tool");
    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "c3",
      arguments: { q: "go" },
    };
    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog, "external"),
    ).toThrow(/owner-only.*'external'/);
  });

  it("non-owner-only tool is unaffected by callerRole", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s4");
    const capId = capIdFor(catalog, "s4", "read_tool");
    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "c4",
      arguments: { q: "go" },
    };
    for (const role of ["owner", "shell", "external"] as CallerRole[]) {
      const result = validateToolInvocation(invocation, agent, capMap, catalog, role);
      expect(result.toolId).toBe("read_tool");
    }
  });

  it("error message is deterministic per (tool, role) — loop guard friendly", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("s5");
    const capId = capIdFor(catalog, "s5", "owner_tool");
    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "c5",
      arguments: { q: "go" },
    };

    let firstMsg = "";
    let secondMsg = "";
    try {
      validateToolInvocation(invocation, agent, capMap, catalog, "shell");
    } catch (err) {
      firstMsg = (err as Error).message;
    }
    try {
      validateToolInvocation(invocation, agent, capMap, catalog, "shell");
    } catch (err) {
      secondMsg = (err as Error).message;
    }
    expect(firstMsg).toBe(secondMsg);
    expect(firstMsg.length).toBeGreaterThan(0);
  });
});

describe("owner-only routing — audit log integration", () => {
  it("audit hash is stable when callerRole is undefined (backward compat)", () => {
    const log = createAuditLog({ maxEntries: 10 });
    const a = log.record({
      timestamp: "2026-04-28T00:00:00Z",
      sessionKey: "s",
      toolId: "t",
      toolName: "t",
      effectClass: "read",
      callId: "c",
      parameters: {},
      resultStatus: "success",
      durationMs: 1,
    });
    const verdict = log.verify();
    expect(verdict.valid).toBe(true);
    expect(a.callerRole).toBeUndefined();
    expect(a.ownerOnly).toBeUndefined();
  });

  it("audit chain re-verifies after recording entries with callerRole + ownerOnly", () => {
    const log = createAuditLog({ maxEntries: 10 });
    log.record({
      timestamp: "2026-04-28T00:00:00Z",
      sessionKey: "s",
      toolId: "t",
      toolName: "t",
      effectClass: "read",
      callId: "c1",
      parameters: {},
      resultStatus: "success",
      durationMs: 1,
      callerRole: "owner",
    });
    log.record({
      timestamp: "2026-04-28T00:00:01Z",
      sessionKey: "s",
      toolId: "owner_tool",
      toolName: "owner_tool",
      effectClass: "write",
      callId: "c2",
      parameters: {},
      resultStatus: "denied",
      durationMs: 0,
      callerRole: "shell",
      ownerOnly: true,
    });
    const verdict = log.verify();
    expect(verdict.valid).toBe(true);
  });

  it("changing a recorded callerRole breaks the chain (forensic integrity)", () => {
    const log = createAuditLog({ maxEntries: 10 });
    log.record({
      timestamp: "2026-04-28T00:00:00Z",
      sessionKey: "s",
      toolId: "owner_tool",
      toolName: "owner_tool",
      effectClass: "write",
      callId: "c1",
      parameters: {},
      resultStatus: "denied",
      durationMs: 0,
      callerRole: "shell",
      ownerOnly: true,
    });
    const entries = log.getEntries();
    // tamper: an attacker swaps "shell" → "owner" trying to launder a denial
    (entries[0] as { callerRole: string }).callerRole = "owner";
    const verdict = log.verify();
    expect(verdict.valid).toBe(false);
  });
});

describe("owner-only routing — loop integration smoke", () => {
  it("EffectDeniedError is the thrown class — inference loop's deny path catches it", () => {
    // Sanity test: the loop in inference.ts checks `err instanceof
    // EffectDeniedError` to decide whether to hard-stop the batch vs let
    // the LLM retry. Owner-only denials must produce that exact class so
    // we never spin in retry-loops on a denied tool.
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("loop-s");
    const capId = capIdFor(catalog, "loop-s", "owner_tool");
    let caught: unknown = null;
    try {
      validateToolInvocation(
        { capabilityId: capId, callId: "c", arguments: { q: "go" } },
        agent,
        capMap,
        catalog,
        "shell",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EffectDeniedError);
  });

  // Spy that the catalog never gets called for a list of caps from a
  // shell session that includes owner-only tools — they're filtered out
  // before declarations ever leave getToolDeclarations.
  it("getToolDeclarations does not surface owner-only cap to non-owner", () => {
    const catalog = buildCatalogWithOwnerOnly();
    const agent = makeAgent();
    const capMap = catalog.mintCapabilityMap("loop-shell");
    const decls = catalog.getToolDeclarations(agent, capMap, "shell");
    const ownerCapId = capIdFor(catalog, "loop-shell", "owner_tool");
    const declNames = new Set(decls.map((d) => d.name));
    expect(declNames.has(ownerCapId)).toBe(false);
    // and the read tool's cap id IS in there
    const readCapId = capIdFor(catalog, "loop-shell", "read_tool");
    expect(declNames.has(readCapId)).toBe(true);
  });
});

// Suppress unused-import warning if vi was not consumed in a given environment.
void vi;
