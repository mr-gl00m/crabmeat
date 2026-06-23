/**
 * Capability-wall regression tests.
 *
 * The "honest capability-wall reporting" invariant from Phase 4.10 in the
 * ship checklist (and memory/project_validated_capabilities.md) says: when
 * CrabMeat cannot do something, it says so — structured, legible, and in a
 * way the LLM will see. Fabrication is the failure mode we never want.
 *
 * This file is the CI regression canary for that property. It covers:
 *
 *   1. web_fetch 403 — HTTP paywall surfaces as isError with the status
 *   2. web_fetch timeout — slow-loris / abort surfaces as isError with duration
 *   3. Capability-mismatch — a tool outside allowedEffects is rejected by the
 *      validation gate with a reason the agent can reason about
 *   4. Missing-secret — $SECRET:nonexistent returns structured error, never
 *      silently empty or substituted
 *   5. Multi-turn preservation — the wrapped TOOL_RESULT block carries
 *      status="error" so any future turn re-reading history still sees the
 *      wall (the "Pokemon cards thread" shape — prior wall-hits stay visible
 *      across session load because they're baked into the transcript).
 *
 * If any of these regress, the agent starts lying about its capabilities.
 * That is the primary failure mode CrabMeat exists to avoid.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinTools, setWorkspaceRoot } from "./builtins.js";
import { getToolHandler } from "./handlers.js";
import { executeValidatedTool } from "./invoke.js";
import { validateToolInvocation } from "./validate.js";
import { createToolCatalog } from "./catalog.js";
import { buildSystemPrompt, buildStructuredSystemPrompt } from "../system-prompt.js";
import type { ValidatedInvocation, ToolExecuteHandler, ToolInvocation } from "./types.js";
import type { SecretStore } from "./secrets.js";
import type { AgentConfig, Config } from "../../config/types.js";

let workspace: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-capability-wall-"));
  setWorkspaceRoot(workspace);
  registerBuiltinTools();
});

afterAll(() => {
  setWorkspaceRoot(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web_fetch — HTTP paywall surfaces as structured error", () => {
  it("403 Forbidden returns isError: true with status in content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          url: "https://example.com/403",
          headers: new Headers({ "content-type": "text/html" }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }),
    );

    const handler = getToolHandler("web_fetch");
    const res = await handler({ url: "https://example.com/403" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/HTTP 403/);
    expect(res.content).toMatch(/Forbidden/);
  });

  it("404 Not Found also surfaces as isError with status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          url: "https://example.com/missing",
          headers: new Headers({ "content-type": "text/html" }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }),
    );

    const handler = getToolHandler("web_fetch");
    const res = await handler({ url: "https://example.com/missing" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/HTTP 404/);
  });
});

describe("web_fetch — timeout surfaces as isError with duration", () => {
  it("abort-error (timeout) is reported as 'Request timed out' not fabricated content", async () => {
    // Simulate the AbortController tripping: fetch throws a DOMException-
    // shaped error whose message contains "abort". The handler's catch
    // block branches on that and produces the timeout message.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      }),
    );

    const handler = getToolHandler("web_fetch");
    const res = await handler({ url: "https://example.com/slow" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Request timed out after \d+ms/);
    expect(res.content).toMatch(/https:\/\/example\.com\/slow/);
  });

  it("generic fetch error is also reported as isError, not silently swallowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:443");
      }),
    );

    const handler = getToolHandler("web_fetch");
    const res = await handler({ url: "https://example.com/noconnect" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Fetch error/);
    expect(res.content).toMatch(/ECONNREFUSED/);
  });
});

// ─── capability-mismatch regression ──────────────────────────────

/** Build a minimal config object with one tool declared. */
function makeMinimalConfig(toolId: string, effectClass: "read" | "write" | "exec" | "network" | "privileged"): Config {
  return {
    tools: [
      {
        id: toolId,
        name: toolId,
        description: "test tool",
        effectClass,
        parameters: {
          input: { type: "string", description: "input", required: true, secretRef: false },
        },
        outputs: {},
      },
    ],
    // cast — only `tools` is actually consulted by createToolCatalog in these tests
  } as unknown as Config;
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    model: "test-model",
    systemPrompt: "test",
    tools: ["read_only_tool"],
    allowedEffects: ["read"],
    ...overrides,
  } as AgentConfig;
}

describe("capability-mismatch — validation gate rejects with structured reason", () => {
  it("tool outside allowedEffects is rejected with the effect class in the message", () => {
    const config = makeMinimalConfig("write_tool", "write");
    const catalog = createToolCatalog(config, "test-secret");
    const agent = makeAgentConfig({
      tools: ["write_tool"],
      allowedEffects: ["read"], // explicitly no 'write'
    });
    const capMap = catalog.mintCapabilityMap("session-1");
    // Find the cap ID for write_tool
    let capId = "";
    for (const [k, v] of capMap) {
      if (v === "write_tool") { capId = k; break; }
    }

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: { input: "x" },
    };

    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog),
    ).toThrow(/Effect class 'write' is not permitted.*Allowed: \[read\]/);
  });

  it("unknown capability ID (leaked from another session) is rejected", () => {
    const config = makeMinimalConfig("read_only_tool", "read");
    const catalog = createToolCatalog(config, "test-secret");
    const agent = makeAgentConfig({ tools: ["read_only_tool"], allowedEffects: ["read"] });
    const capMap = catalog.mintCapabilityMap("session-1");

    const invocation: ToolInvocation = {
      capabilityId: "cap_deadbeefcafe", // nonsense
      callId: "call-1",
      arguments: { input: "x" },
    };

    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog),
    ).toThrow(/Unknown capability ID/);
  });

  it("tool not in agent's allowed tool list is rejected with agent-specific reason", () => {
    const config: Config = {
      tools: [
        {
          id: "forbidden",
          name: "forbidden",
          description: "x",
          effectClass: "read",
          parameters: { input: { type: "string", description: "x", required: true, secretRef: false } },
          outputs: {},
        },
      ],
    } as unknown as Config;
    const catalog = createToolCatalog(config, "test-secret");
    const agent = makeAgentConfig({ tools: [], allowedEffects: ["read"] });
    const capMap = catalog.mintCapabilityMap("session-1");

    let capId = "";
    for (const [k, v] of capMap) { if (v === "forbidden") { capId = k; break; } }

    expect(() =>
      validateToolInvocation(
        { capabilityId: capId, callId: "c1", arguments: { input: "x" } },
        agent,
        capMap,
        catalog,
      ),
    ).toThrow(/not permitted for this agent/);
  });
});

// ─── missing-secret regression ──────────────────────────────

function makeInvocation(overrides: Partial<ValidatedInvocation> = {}): ValidatedInvocation {
  return {
    toolId: "test-tool",
    toolName: "test_tool",
    callId: "call-1",
    parameters: {},
    effectClass: "read",
    ...overrides,
  };
}

function makeSecretStore(secrets: Record<string, string> = {}): SecretStore {
  return {
    resolve(name) { return secrets[name]; },
  };
}

describe("missing-secret — structured error, never silent substitution", () => {
  it("missing $SECRET: returns isError: true and never invokes the handler", async () => {
    const handler = vi.fn<ToolExecuteHandler>(async () => ({ content: "should not run" }));
    const result = await executeValidatedTool(
      makeInvocation({ parameters: { token: "$SECRET:NOT_SET_IN_ENV" } }),
      handler,
      makeSecretStore({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Secret 'NOT_SET_IN_ENV' not found/);
    // Critical: the handler must never execute with an empty-or-substituted
    // value. Silent substitution is the exact failure mode this test exists
    // to prevent.
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT fall back to empty string when secret is missing", async () => {
    const handler = vi.fn<ToolExecuteHandler>(async (params) => ({
      content: `token was: '${String(params.token)}'`,
    }));
    const result = await executeValidatedTool(
      makeInvocation({ parameters: { token: "$SECRET:MISSING" } }),
      handler,
      makeSecretStore({}),
    );
    // Handler should not run, so result must be the error, not the handler's echo
    expect(handler).not.toHaveBeenCalled();
    expect(result.content).not.toContain("token was: ''");
    expect(result.isError).toBe(true);
  });
});

// ─── multi-turn preservation regression ─────────────────────────

describe("multi-turn wall preservation — TOOL_RESULT carries status so prior wall-hits persist", () => {
  it("error result wraps with status=\"error\" so history readers always see the wall", async () => {
    const failingHandler: ToolExecuteHandler = async () => ({
      content: "HTTP 403 Forbidden for https://example.com/paywall",
      isError: true,
    });

    const result = await executeValidatedTool(
      makeInvocation({ toolName: "web_fetch" }),
      failingHandler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(true);
    // The wrapped content is what lands in the transcript and the next turn.
    // If status="error" falls off this tag, a future turn reading back the
    // history can't distinguish a real "HTTP 403" fact from some narrative
    // the agent wrote about HTTP 403. The status attribute is the machine-
    // readable flag that preserves the wall across the session boundary.
    expect(result.content).toMatch(/<TOOL_RESULT[^>]+status="error"/);
    expect(result.content).toMatch(/tool="web_fetch"/);
    expect(result.content).toContain("HTTP 403 Forbidden");
    expect(result.content).toContain("</TOOL_RESULT>");
  });

  it("successful result does NOT carry status=\"error\" (prevents false-positive walls on replay)", async () => {
    const okHandler: ToolExecuteHandler = async () => ({
      content: "<html>real content</html>",
    });

    const result = await executeValidatedTool(
      makeInvocation({ toolName: "web_fetch" }),
      okHandler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).not.toMatch(/status="error"/);
    // The tag is still there, but without the error marker — this is what a
    // future turn needs to see to know the prior call succeeded.
    expect(result.content).toMatch(/<TOOL_RESULT[^>]+tool="web_fetch"/);
  });
});

// ─── post-call honesty regression ───────────────────────────────
//
// Regression canary for the "AI_Cybersecurity_Report_2026.md incident"
// (2026-04-24): all three tool calls in a turn errored (file_copy, email_attach,
// message_send) and the model still narrated "Attached X — compiled research…"
// The tool layer did its job (status="error" was stamped on each TOOL_RESULT);
// the gap was the system prompt, which covered pre-call honesty ("don't fake a
// tool you don't have") but not post-call honesty ("don't fake a result for a
// tool you called that errored"). These tests guard the prompt-layer half of
// the wall so the fix can't silently regress.

function makeAgentCfg(tools: string[] = []): AgentConfig {
  return {
    id: "test",
    name: "Test Agent",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.7,
    maxTokens: 4096,
    charsPerToken: 3.5,
    strictInstructions: false,
    tools,
    allowedEffects: ["read", "write", "network"],
    maxToolIterations: 5,
  } as AgentConfig;
}

describe("post-call honesty — prompt tells the model not to narrate errored calls", () => {
  it("system prompt contains the TOOL_RESULT_HONESTY block when tools are present", () => {
    const prompt = buildSystemPrompt(makeAgentCfg(["email_attach", "file_copy", "message_send"]));
    expect(prompt).toContain("<TOOL_RESULT_HONESTY>");
    expect(prompt).toContain("</TOOL_RESULT_HONESTY>");
    // The rule must specifically mention status="error" so the model
    // connects it to the wrapper from wrapToolResult().
    expect(prompt).toContain('status="error"');
    // And must name the exact confabulation verbs from the incident.
    expect(prompt).toMatch(/attached/i);
    expect(prompt).toMatch(/sent/i);
  });

  it("rule lives in the cached region (stable per session, not per turn)", () => {
    const { cached, dynamic } = buildStructuredSystemPrompt(
      makeAgentCfg(["email_attach"]),
    );
    expect(cached).toContain("<TOOL_RESULT_HONESTY>");
    expect(dynamic).not.toContain("<TOOL_RESULT_HONESTY>");
  });

  it("an errored TOOL_RESULT from the wall carries a status the prompt rule can key on", async () => {
    // Cross-check: the two halves of the wall have to agree. The tool layer
    // stamps status="error", and the prompt tells the model to treat that
    // stamp as "effect did not happen." If either half drifts, this pairing
    // test breaks.
    const failingHandler: ToolExecuteHandler = async () => ({
      content: "email_attach: file not found: '/tmp/fake.md'",
      isError: true,
    });
    const result = await executeValidatedTool(
      makeInvocation({ toolName: "email_attach" }),
      failingHandler,
      makeSecretStore(),
    );
    const prompt = buildSystemPrompt(makeAgentCfg(["email_attach"]));

    // Tool layer: stamps status="error"
    expect(result.content).toMatch(/status="error"/);
    // Prompt layer: keys on status="error"
    expect(prompt).toContain('status="error"');
  });
});
