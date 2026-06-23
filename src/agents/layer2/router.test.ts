import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleLayer2 } from "./router.js";
import { resetHealthCache } from "./health.js";
import type { Layer2Context } from "./types.js";
import type { Provider, StreamEvent } from "../providers/types.js";
import type { ConnectorSink } from "../../connectors/types.js";
import type { Session } from "../../sessions/types.js";
import type { SessionStore } from "../../sessions/store.js";
import type { AuditLog } from "../../security/audit.js";
import type { Layer2Config } from "../../config/types.js";

const DEFAULT_CONFIG: Layer2Config = {
  enabled: true,
  providerId: "ollama-local",
  confidenceThreshold: 0.5,
  confidenceCeiling: 0.69,
  maxTokens: 256,
  temperature: 0.3,
  escalationMarkers: [
    "I'm not sure",
    "I don't know",
    "I need more context",
  ],
  healthCheckTimeoutMs: 2000,
  showLayerBadge: false,
  systemPrompt: "You are a disambiguation assistant.",
};

function makeProvider(responseText: string, opts?: { fail?: boolean }): Provider {
  return {
    id: "ollama-local",
    type: "openai",
    stream: vi.fn(async (_req, onEvent) => {
      if (opts?.fail) {
        onEvent({ type: "error", error: new Error("Ollama down"), retryable: false } as StreamEvent);
        return;
      }
      // Emit tokens character by character (simplified)
      onEvent({ type: "token", text: responseText } as StreamEvent);
      onEvent({ type: "done", usage: { promptTokens: 10, completionTokens: responseText.length } } as StreamEvent);
    }),
  };
}

function makeSink(): ConnectorSink {
  return {
    sendToken: vi.fn(),
    sendDone: vi.fn(),
    sendError: vi.fn(),
    sendToolStatus: vi.fn(),
    sendAuditEntry: vi.fn(),
  };
}

function makeSession(): Session {
  return {
    sessionKey: "test-session",
    agentId: "default",
    transcript: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeStore(): SessionStore {
  return {
    async load() { return undefined; },
    async save() {},
    create: vi.fn() as any,
    async list() { return []; },
  };
}

function makeAuditLog(): AuditLog {
  return {
    record: vi.fn(() => ({
      timestamp: "", sessionKey: "", toolId: "", toolName: "",
      effectClass: "read", callId: "", parameters: {},
      resultStatus: "success", durationMs: 0, hash: "", prevHash: "",
    })),
    getEntries: vi.fn(() => []),
    getChainHead: vi.fn(() => undefined),
  } as unknown as AuditLog;
}

function makeCtx(overrides?: Partial<{
  config: Partial<Layer2Config>;
  provider: Provider;
  sink: ConnectorSink;
  session: Session;
  layer0Confidence: number;
}>): Layer2Context {
  const provider = overrides?.provider ?? makeProvider("Did you mean X or Y?");
  return {
    config: { ...DEFAULT_CONFIG, ...(overrides?.config ?? {}) },
    provider,
    sink: overrides?.sink ?? makeSink(),
    session: overrides?.session ?? makeSession(),
    sessionKey: "test-session",
    store: makeStore(),
    auditLog: makeAuditLog(),
    layer0Confidence: overrides?.layer0Confidence ?? 0.55,
  };
}

describe("handleLayer2", () => {
  beforeEach(() => {
    resetHealthCache();
  });

  it("returns handled:false when disabled", async () => {
    const ctx = makeCtx({ config: { enabled: false } });
    const result = await handleLayer2("hello", ctx);
    expect(result.handled).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("returns handled:false when provider is unhealthy", async () => {
    const provider = makeProvider("", { fail: true });
    const ctx = makeCtx({ provider });
    const result = await handleLayer2("hello", ctx);
    expect(result.handled).toBe(false);
    expect(result.reason).toContain("unhealthy");
  });

  it("handles disambiguation response successfully", async () => {
    const sink = makeSink();
    const ctx = makeCtx({ sink, provider: makeProvider("Did you mean rename or delete?") });
    const result = await handleLayer2("clean up files", ctx);

    expect(result.handled).toBe(true);
    expect(result.escalated).toBe(false);
    // Tokens are streamed incrementally to the client
    expect(sink.sendToken).toHaveBeenCalled();
    expect(sink.sendDone).toHaveBeenCalled();
  });

  it("escalates when model hedges", async () => {
    const ctx = makeCtx({ provider: makeProvider("I'm not sure how to interpret that.") });
    const result = await handleLayer2("do something", ctx);

    expect(result.handled).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.reason).toContain("I'm not sure");
  });

  it("escalates when model says 'I need more context'", async () => {
    const ctx = makeCtx({ provider: makeProvider("I need more context to help with that.") });
    const result = await handleLayer2("complex task", ctx);

    expect(result.handled).toBe(false);
    expect(result.escalated).toBe(true);
  });

  it("records audit entry on every routing decision", async () => {
    const auditLog = makeAuditLog();
    const ctx = makeCtx({ provider: makeProvider("Simple answer.") });
    ctx.auditLog = auditLog;

    await handleLayer2("what is this", ctx);
    expect(auditLog.record).toHaveBeenCalled();

    const auditArg = (auditLog.record as any).mock.calls[0][0];
    expect(auditArg.toolId).toBe("__layer2_routing");
    expect(auditArg.sessionKey).toBe("test-session");
  });

  it("updates transcript when handled", async () => {
    const session = makeSession();
    const ctx = makeCtx({ session, provider: makeProvider("Here's your answer.") });

    await handleLayer2("question", ctx);

    // Should have 2 new entries: user + assistant
    expect(session.transcript.length).toBe(2);
    expect(session.transcript[0]!.role).toBe("user");
    expect(session.transcript[0]!.content).toBe("question");
    expect(session.transcript[1]!.role).toBe("assistant");
    expect(session.transcript[1]!.content).toBe("Here's your answer.");
  });

  it("applies [L2] badge when showLayerBadge is true", async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      sink,
      config: { showLayerBadge: true },
      provider: makeProvider("Short answer."),
    });

    await handleLayer2("question", ctx);

    // First sendToken call should include the [L2] prefix
    const firstCall = (sink.sendToken as any).mock.calls[0];
    expect(firstCall[0]).toMatch(/^\[L2\] /);
  });

  it("falls through gracefully on stream error", async () => {
    const provider = makeProvider("", { fail: true });
    // Need a healthy provider for the health check, then failing for the actual call
    // Trick: make health check pass by giving it a fresh provider, then swap
    const healthyProvider = makeProvider("ok");
    const ctx = makeCtx({ provider: healthyProvider });

    // Prime health cache with healthy state
    await handleLayer2("test", ctx);
    resetHealthCache();

    // Now use failing provider
    const ctx2 = makeCtx({ provider });
    const result = await handleLayer2("will fail", ctx2);

    // Should not have handled (stream error or unhealthy)
    expect(result.handled).toBe(false);
    expect(result.escalated).toBe(false);
  });

  it("does not send sendDone when escalating", async () => {
    const sink = makeSink();
    const ctx = makeCtx({
      sink,
      provider: makeProvider("I don't know the answer to that."),
    });

    const result = await handleLayer2("hard question", ctx);

    // EscalationLeadBuffer catches the marker before tokens commit
    // to the sink, so the user does not see "I don't know..." stutter
    // before Layer 3 takes over. sendDone is not called either —
    // Layer 3 produces the final response and sends its own.
    expect(result.escalated).toBe(true);
    expect(sink.sendDone).not.toHaveBeenCalled();
    expect(sink.sendToken).not.toHaveBeenCalled();
  });

  it("does not stream Layer 2 tokens to client when escalation appears in the lead", async () => {
    // Direct regression guard for the lead-buffer behavior — the user
    // must not see the local model's hedge before Layer 3 fires.
    const sink = makeSink();
    const ctx = makeCtx({
      sink,
      provider: makeProvider("I'm not sure what you mean by that question."),
    });

    const result = await handleLayer2("ambiguous", ctx);

    expect(result.escalated).toBe(true);
    expect(result.reason).toContain("I'm not sure");
    expect(sink.sendToken).not.toHaveBeenCalled();
    expect(sink.sendDone).not.toHaveBeenCalled();
  });
});
