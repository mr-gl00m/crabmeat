/**
 * Red Team Security Tests — Inference-Loop Deny Path (integration)
 *
 * The sibling suite (redteam-multiturn-escalation.test.ts) proves the
 * deterministic gate (validateToolInvocation) refuses escalation in isolation.
 * This suite proves the GATE IS WIRED INTO THE LOOP correctly — it drives the
 * REAL inference pipeline (createInferencePipeline → handleTurn) with a fake
 * Provider that emits scripted tool calls, and asserts the control flow around
 * a denial:
 *
 *   1. A denied tool call HARD-STOPS the batch — every later call in the same
 *      assistant turn is stubbed, not executed.
 *   2. The denied tool's handler NEVER runs (denial happens at validate time,
 *      before execution).
 *   3. There is NO RETRY — a denial breaks the agent loop; the model does not
 *      get another turn to try again. (Contrast: an ordinary execution error
 *      IS non-fatal and the model does get another turn.)
 *   4. Multi-turn escalation: benign turns that build "trust" do not unlock a
 *      later escalation; the escalation is denied on turn N exactly as it would
 *      be on turn 1, and the loop halts.
 *   5. Every outcome lands on the tamper-evident audit chain with the right
 *      resultStatus.
 *
 * The fake Provider learns capability IDs the only way a real model can — from
 * the tool declarations it is handed in the request — so nothing here depends
 * on the per-deployment HMAC secret.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInferencePipeline } from "../src/agents/inference.js";
import {
  registerToolHandler,
  clearToolHandlers,
} from "../src/agents/tools/handlers.js";
import type { Config } from "../src/config/types.js";
import type { Session } from "../src/sessions/types.js";
import type { SessionStore } from "../src/sessions/store.js";
import type {
  Provider,
  ProviderRequest,
  ToolCallRequest,
} from "../src/agents/providers/types.js";
import type { ToolExecuteHandler } from "../src/agents/tools/types.js";

// The provider registry creates real SDK clients — mock it so we can inject a
// fake provider. Same seam the unit suite (src/agents/inference.test.ts) uses.
vi.mock("../src/agents/providers/registry.js", () => ({
  createProviderRegistry: vi.fn(() => []),
}));
import { createProviderRegistry } from "../src/agents/providers/registry.js";
const mockedCreateRegistry = vi.mocked(createProviderRegistry);

// ── Harness (mirrors src/agents/inference.test.ts) ───────────────

function mockSink(open = true): { sink: any; sent: any[] } {
  const sent: any[] = [];
  const sink = {
    sendToken: vi.fn((token: string, sessionId: string) => {
      sent.push({ type: "event", event: "chat.token", data: { token, sessionId } });
    }),
    sendDone: vi.fn((sessionId: string, messageId: string) => {
      sent.push({ type: "event", event: "chat.done", data: { sessionId, messageId } });
    }),
    sendError: vi.fn((code: string, message: string) => {
      sent.push({ type: "error", error: { code, message } });
    }),
    sendToolStatus: vi.fn((sessionId: string, toolName: string, callId: string, status: string) => {
      sent.push({ type: "event", event: "tool.execute", data: { sessionId, toolName, callId, status } });
    }),
    sendAuditEntry: vi.fn((entry: unknown) => {
      sent.push({ type: "event", event: "audit.entry", data: entry });
    }),
    isOpen: vi.fn(() => open),
  };
  return { sink, sent };
}

function mockStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async load(key) {
      return sessions.get(key);
    },
    async save(session) {
      sessions.set(session.sessionKey, session);
    },
    create(key, agentId, channelId?, peerId?) {
      return {
        sessionKey: key,
        agentId,
        channelId,
        peerId,
        transcript: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async list() {
      return [...sessions.keys()];
    },
    async prefetch() {
      // no-op: in-memory store, nothing to page-cache
    },
  };
}

/**
 * Read-only assistant: the high-impact tools are declared in `tools` (so the
 * model can — and the fake model will — emit calls for them) but the agent is
 * granted only the `read` effect class. The deny path is the only thing
 * standing between the model and a write/exec effect.
 */
function makeConfig(): Config {
  const mkTool = (id: string, effectClass: string, description: string) => ({
    id,
    name: id,
    description,
    effectClass,
    parameters: {
      input: { type: "string", description: "in", required: true, secretRef: false },
    },
    outputs: {},
  });
  return {
    gateway: { host: "127.0.0.1", port: 3000, auth: { mode: "none" }, origins: [] },
    agents: [
      {
        id: "test-agent",
        name: "Test",
        systemPrompt: "You are a test agent.",
        temperature: 0.7,
        maxTokens: 4096,
        // Deliberately non-builtin tool ids — `notes_read`/`shell` etc. are real
        // agent-data/builtin handlers that registerBuiltinTools() wires during
        // pipeline construction, which would shadow our execution spies.
        tools: ["rt_read", "rt_write", "rt_exec"],
        allowedEffects: ["read"],
        maxToolIterations: 5,
        // Hand-built config bypasses the loader's defaults; the tool path
        // reads this directly, so supply a permissive limiter (we make ≤3 calls).
        toolRateLimit: { windowMs: 60_000, maxCalls: 100, lockoutMs: 1_000 },
      },
    ],
    providers: [
      { id: "mock", type: "openai", apiKey: "sk-test", model: "test-model", maxRetries: 0, timeoutMs: 5000 },
    ],
    session: { backend: "json", dir: ".test/sessions", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "test-agent", bindings: [] },
    tools: [
      mkTool("rt_read", "read", "READ_TOOL"),
      mkTool("rt_write", "write", "WRITE_TOOL"),
      mkTool("rt_exec", "exec", "EXEC_TOOL"),
    ],
  } as unknown as Config;
}

function setupPipeline(stream: Provider["stream"]) {
  const provider: Provider = { id: "mock", type: "openai", model: "test-model", stream };
  mockedCreateRegistry.mockReturnValue([provider]);
  const pipeline = createInferencePipeline(makeConfig());
  // Register AFTER construction: createInferencePipeline() calls
  // registerBuiltinTools() synchronously, and the registry has no clear step,
  // so registering here guarantees our spies win for rt_* ids.
  registerToolHandler("rt_read", readSpy as unknown as ToolExecuteHandler);
  registerToolHandler("rt_write", writeSpy as unknown as ToolExecuteHandler);
  return pipeline;
}

/**
 * Find the capability ID the pipeline minted for a tool, by its declared
 * description. The fake model only knows caps from the request it's handed —
 * exactly like a real model — so this never touches the HMAC secret.
 */
function capFor(req: ProviderRequest, description: string): string {
  const decl = req.tools?.find((t) => t.description === description);
  if (!decl) throw new Error(`tool '${description}' was not surfaced to the provider`);
  return decl.name;
}

function toolCall(id: string, capId: string): ToolCallRequest {
  return { id, name: capId, arguments: JSON.stringify({ input: "x" }) };
}

// ── Spies on tool execution ──────────────────────────────────────

let readSpy: ReturnType<typeof vi.fn>;
let writeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearToolHandlers();
  readSpy = vi.fn(async () => ({ content: "read ok" }));
  writeSpy = vi.fn(async () => ({ content: "write done" }));
  // Registration happens inside setupPipeline(), after construction.
});

// ── RT-DENY-001: a denial hard-stops the batch ───────────────────

describe("RT-DENY-001: a denied tool call hard-stops the rest of the batch", () => {
  it("the denied tool and every call after it never execute; one turn only", async () => {
    let streamCalls = 0;
    const pipeline = setupPipeline(async (req, onEvent) => {
      streamCalls += 1;
      onEvent({
        type: "tool_call",
        toolCalls: [
          toolCall("tc-write", capFor(req, "WRITE_TOOL")), // denied (effect not granted)
          toolCall("tc-read", capFor(req, "READ_TOOL")), // would be allowed, but never reached
        ],
      });
      onEvent({ type: "done", fullText: "" });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "write then read", store);

    // The write was denied at validate time — its handler never ran.
    expect(writeSpy).not.toHaveBeenCalled();
    // The trailing read was stubbed by the hard-stop — its handler never ran.
    expect(readSpy).not.toHaveBeenCalled();
    // No retry: the model got exactly one turn.
    expect(streamCalls).toBe(1);

    // Audit recorded exactly one denial.
    const denied = pipeline.auditLog.getEntries().filter((e) => e.resultStatus === "denied");
    expect(denied).toHaveLength(1);

    // The trailing read landed in the transcript as a "Tool denied" stub, not a result.
    const readStub = session.transcript.find(
      (e) => e.role === "tool" && (e as { toolCallId?: string }).toolCallId === "tc-read",
    );
    expect(readStub?.content).toContain("Tool denied");

    // The loop surfaced a TOOL_ERROR to the client.
    expect(sent.some((x) => x.type === "error" && x.error.code === "TOOL_ERROR")).toBe(true);
  });
});

// ── RT-DENY-002: allowed calls before the denial still run ───────

describe("RT-DENY-002: a denial stops calls after it, not before it", () => {
  it("an allowed read before the denied write executes; an allowed read after it is stubbed", async () => {
    let streamCalls = 0;
    const pipeline = setupPipeline(async (req, onEvent) => {
      streamCalls += 1;
      onEvent({
        type: "tool_call",
        toolCalls: [
          toolCall("r1", capFor(req, "READ_TOOL")), // allowed → executes
          toolCall("w1", capFor(req, "WRITE_TOOL")), // denied → hard stop
          toolCall("r2", capFor(req, "READ_TOOL")), // stubbed → never executes
        ],
      });
      onEvent({ type: "done", fullText: "" });
    });

    const { session } = await runTurn(pipeline, "read, write, read");

    expect(readSpy).toHaveBeenCalledTimes(1); // r1 ran; r2 was stubbed
    expect(writeSpy).not.toHaveBeenCalled();
    expect(streamCalls).toBe(1);

    const entries = pipeline.auditLog.getEntries();
    expect(entries.filter((e) => e.resultStatus === "success" && e.toolId === "rt_read")).toHaveLength(1);
    expect(entries.filter((e) => e.resultStatus === "denied")).toHaveLength(1);

    const r2Stub = session.transcript.find(
      (e) => e.role === "tool" && (e as { toolCallId?: string }).toolCallId === "r2",
    );
    expect(r2Stub?.content).toContain("Tool denied");
  });
});

// ── RT-DENY-003: denial is a HARD stop, execution error is not ───

describe("RT-DENY-003: a denial gets no retry turn, unlike an ordinary execution error", () => {
  it("an execution error (isError) gives the model another turn", async () => {
    let streamCalls = 0;
    const pipeline = setupPipeline(async (req, onEvent) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        onEvent({ type: "tool_call", toolCalls: [toolCall("r1", capFor(req, "READ_TOOL"))] });
        onEvent({ type: "done", fullText: "" });
      } else {
        onEvent({ type: "token", text: "recovered" });
        onEvent({ type: "done", fullText: "recovered" });
      }
    });
    // Read is allowed but its handler reports a soft failure. The loop should
    // surface the error to the transcript and let the model try again. Override
    // after setupPipeline (which registered the default success spy).
    registerToolHandler(
      "rt_read",
      (async () => ({ content: "transient failure", isError: true })) as unknown as ToolExecuteHandler,
    );

    await runTurn(pipeline, "read");

    // Two turns: the soft error did NOT hard-stop the loop.
    expect(streamCalls).toBe(2);
  });

  it("a denial halts the loop at one turn (the contrast)", async () => {
    let streamCalls = 0;
    const pipeline = setupPipeline(async (req, onEvent) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        onEvent({ type: "tool_call", toolCalls: [toolCall("w1", capFor(req, "WRITE_TOOL"))] });
        onEvent({ type: "done", fullText: "" });
      } else {
        // If the loop ever gives the model a second turn after a denial, this
        // fires and the streamCalls assertion below catches it.
        onEvent({ type: "token", text: "should never run" });
        onEvent({ type: "done", fullText: "x" });
      }
    });

    await runTurn(pipeline, "write");

    expect(writeSpy).not.toHaveBeenCalled();
    expect(streamCalls).toBe(1); // denial = no retry
  });
});

// ── RT-DENY-004: multi-turn escalation halts at the gate ─────────

describe("RT-DENY-004: benign turns do not unlock a later escalation", () => {
  it("two benign read turns then a write turn — the write is denied and the loop halts", async () => {
    let streamCalls = 0;
    const pipeline = setupPipeline(async (req, onEvent) => {
      streamCalls += 1;
      if (streamCalls <= 2) {
        // Turns 1–2: legitimate reads (build "trust").
        onEvent({ type: "tool_call", toolCalls: [toolCall(`r${streamCalls}`, capFor(req, "READ_TOOL"))] });
      } else {
        // Turn 3: escalate to a write.
        onEvent({ type: "tool_call", toolCalls: [toolCall("w1", capFor(req, "WRITE_TOOL"))] });
      }
      onEvent({ type: "done", fullText: "" });
    });

    await runTurn(pipeline, "slow boil");

    expect(readSpy).toHaveBeenCalledTimes(2); // both benign reads ran
    expect(writeSpy).not.toHaveBeenCalled(); // escalation denied, never executed
    expect(streamCalls).toBe(3); // 2 benign + 1 escalation; no 4th turn (no retry)

    const entries = pipeline.auditLog.getEntries();
    expect(entries.filter((e) => e.resultStatus === "success" && e.toolId === "rt_read")).toHaveLength(2);
    expect(entries.filter((e) => e.resultStatus === "denied")).toHaveLength(1);

    // The whole turn's receipts are tamper-evident and intact.
    expect(pipeline.auditLog.verify().valid).toBe(true);
  });
});

// ── helper ───────────────────────────────────────────────────────

async function runTurn(
  pipeline: ReturnType<typeof createInferencePipeline>,
  userContent: string,
): Promise<{ sink: any; sent: any[]; session: Session; store: SessionStore }> {
  const { sink, sent } = mockSink();
  const store = mockStore();
  const session = store.create("s1", "test-agent");
  await pipeline.handleTurn(sink, session, userContent, store);
  return { sink, sent, session, store };
}
