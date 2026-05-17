import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachMessageHandler } from "./handler.js";
import type { Config } from "../../config/types.js";
import type { InferencePipeline } from "../../agents/inference.js";
import type { SessionStore } from "../../sessions/store.js";
import type { Session } from "../../sessions/types.js";
import { EventEmitter } from "node:events";

function makeConfig(): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: 3000,
      auth: { mode: "none" },
      origins: [],
    },
    agents: [
      {
        id: "default",
        name: "Test Agent",
        systemPrompt: "Test",
        temperature: 0.7,
        maxTokens: 4096,
        tools: [],
        allowedEffects: ["read"],
        maxToolIterations: 5,
      },
    ],
    providers: [
      { id: "mock", type: "openai", apiKey: "sk-test", model: "test", maxRetries: 0, timeoutMs: 5000 },
    ],
    session: { backend: "json", dir: ".test/sessions", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "default", bindings: [] },
    tools: [],
    layer2: {
      enabled: false,
      providerId: "",
      confidenceThreshold: 0.5,
      confidenceCeiling: 0.69,
      maxTokens: 256,
      temperature: 0.3,
      escalationMarkers: [],
      healthCheckTimeoutMs: 2000,
      showLayerBadge: false,
      systemPrompt: "Test",
    },
  } as Config;
}

function mockWs() {
  const emitter = new EventEmitter();
  const sent: any[] = [];
  const ws = Object.assign(emitter, {
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data));
    }),
    readyState: 1,
    OPEN: 1,
  });
  return { ws: ws as any, sent };
}

function mockPipeline(): InferencePipeline {
  return {
    handleTurn: vi.fn(async () => {}),
    getProvider: vi.fn(() => undefined),
    getArbiterProviderFn: vi.fn(() => async function* () { /* unused */ }),
  } as unknown as InferencePipeline;
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
      const s: Session = {
        sessionKey: key,
        agentId,
        channelId,
        peerId,
        transcript: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(key, s);
      return s;
    },
    async list() {
      return [...sessions.keys()];
    },
  };
}

function sendFrame(ws: any, frame: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify(frame)));
}

// Wait for async handlers dispatched with void + catch
function tick(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("attachMessageHandler", () => {
  it("rejects already-connected connect requests", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "connect", params: { protocolVersion: 1 } });
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("error");
    expect(sent[0].error.code).toBe("ALREADY_CONNECTED");
  });

  it("dispatches chat.send to the inference pipeline", async () => {
    const { ws, sent } = mockWs();
    const pipeline = mockPipeline();
    const store = mockStore();
    attachMessageHandler(ws, makeConfig(), pipeline, store);

    sendFrame(ws, { id: "2", type: "req", method: "chat.send", params: { content: "Hello!" } });
    await tick();

    // Should ack with streaming status
    expect(sent.some((s: any) => s.type === "res" && s.status === "ok")).toBe(true);

    // Pipeline should have been called
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
    const [_ws, session, content, _store] = (pipeline.handleTurn as any).mock.calls[0];
    expect(content).toBe("Hello!");
    expect(session.agentId).toBe("default");
  });

  it("rejects invalid JSON", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore());

    ws.emit("message", Buffer.from("not json{{{"));
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].error.code).toBe("INVALID_JSON");
  });

  it("rejects invalid frame structure", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore());

    sendFrame(ws, { garbage: true });
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].error.code).toBe("INVALID_FRAME");
  });

  it("rejects unknown methods", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "unknown.method", params: {} });
    await tick();

    // The frame won't pass the discriminated union schema, so it's INVALID_FRAME
    expect(sent).toHaveLength(1);
  });

  it("rejects oversized frames", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore());

    // Send a frame larger than 1MB
    const bigPayload = "x".repeat(1024 * 1024 + 1);
    ws.emit("message", Buffer.from(bigPayload));
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].error.code).toBe("FRAME_TOO_LARGE");
  });

  it("strips null bytes from input", async () => {
    const { ws, sent } = mockWs();
    const pipeline = mockPipeline();
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Embed null bytes in valid JSON
    const frame = JSON.stringify({
      id: "1",
      type: "req",
      method: "chat.send",
      params: { content: "Hello" },
    });
    const withNulls = frame.slice(0, 5) + "\0" + frame.slice(5);
    ws.emit("message", Buffer.from(withNulls));
    await tick();

    // Should still process successfully (null bytes stripped)
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
  });

  it("enforces session ownership for chat.history", async () => {
    const { ws, sent } = mockWs();
    const store = mockStore();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), store);

    // Request history without having sent a chat.send first
    sendFrame(ws, {
      id: "1",
      type: "req",
      method: "chat.history",
      params: { limit: 10 },
    });
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("error");
    expect(sent[0].error.code).toBe("SESSION_ACCESS_DENIED");
  });

  it("allows chat.history after chat.send establishes ownership", async () => {
    const { ws, sent } = mockWs();
    const store = mockStore();
    const pipeline = mockPipeline();
    attachMessageHandler(ws, makeConfig(), pipeline, store);

    // Establish session via chat.send
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "Hi" } });
    await tick();

    // Now request history
    sendFrame(ws, { id: "2", type: "req", method: "chat.history", params: { limit: 10 } });
    await tick();

    // The history response should succeed
    const historyResponse = sent.find((s: any) => s.replyTo === "2");
    expect(historyResponse).toBeDefined();
    expect(historyResponse.status).toBe("ok");
  });

  it("returns empty entries for non-existent session history", async () => {
    const { ws, sent } = mockWs();
    const store = mockStore();
    // Override load to always return undefined
    store.load = async () => undefined;
    const pipeline = mockPipeline();
    attachMessageHandler(ws, makeConfig(), pipeline, store);

    // Establish ownership
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "Hi" } });
    await tick();

    sendFrame(ws, { id: "2", type: "req", method: "chat.history", params: { limit: 10 } });
    await tick();

    const historyResponse = sent.find((s: any) => s.replyTo === "2");
    expect(historyResponse).toBeDefined();
    expect(historyResponse.status).toBe("ok");
    expect(historyResponse.data.entries).toEqual([]);
  });

  it("handles pipeline errors gracefully", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = {
      handleTurn: vi.fn(async () => {
        throw new Error("Pipeline exploded");
      }),
      getProvider: vi.fn(() => undefined),
    } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "Hi" } });
    await tick();

    // Should get an error response for the frame
    const errorResponse = sent.find((s: any) => s.replyTo === "1" && s.status === "error");
    expect(errorResponse).toBeDefined();
  });
});

describe("RT-2026-04-30-007 — owned-session eviction is observable and gated by pending ask_user", () => {
  // Use a small cap so the fill + overflow stays under the 100-msg/min
  // per-connection rate limiter inside attachMessageHandler. Production
  // call sites omit the override and the real MAX_OWNED_SESSIONS=100
  // applies.
  const CAP = 5;

  async function fillOwnedSessions(
    ws: ReturnType<typeof mockWs>["ws"],
    n: number,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      sendFrame(ws, {
        id: `f-${i}`,
        type: "req",
        method: "chat.send",
        params: { content: "hi", peerId: `peer-${i}` },
      });
    }
    await tick(50);
  }

  it("emits session.evicted when the oldest session is reclaimed", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore(), undefined, {
      maxOwnedSessions: CAP,
    });

    await fillOwnedSessions(ws, CAP);

    sendFrame(ws, {
      id: "f-overflow",
      type: "req",
      method: "chat.send",
      params: { content: "overflow", peerId: "peer-overflow" },
    });
    await tick(50);

    const evictedEvents = sent.filter(
      (s: any) => s.type === "event" && s.event === "session.evicted",
    );
    expect(evictedEvents).toHaveLength(1);
    expect(evictedEvents[0].data.reason).toBe("session_limit_reached");
    expect(typeof evictedEvents[0].data.sessionId).toBe("string");
  });

  it("refuses to evict when ALL owned sessions have a pending ask_user (returns SESSION_LIMIT_REACHED)", async () => {
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), mockPipeline(), mockStore(), undefined, {
      maxOwnedSessions: CAP,
    });

    const broker = await import("../../agents/tools/ask-user-broker.js");
    broker._resetAskUserBroker();

    await fillOwnedSessions(ws, CAP);

    const { resolveRoute } = await import("../../routing/resolve.js");
    const cfg = makeConfig();
    const sessionKeys = Array.from({ length: CAP }, (_, i) =>
      resolveRoute({ peerId: `peer-${i}` }, cfg.routing).sessionKey,
    );
    for (const key of sessionKeys) {
      broker.registerAskUserSender(key, () => {});
      void broker.askQuestion({
        sessionKey: key,
        question: "stuck",
        timeoutMs: 60_000,
      }).catch(() => {});
    }

    sendFrame(ws, {
      id: "f-overflow-locked",
      type: "req",
      method: "chat.send",
      params: { content: "overflow", peerId: "peer-overflow-locked" },
    });
    await tick(50);

    const errorResponse = sent.find(
      (s: any) =>
        s.type === "res" &&
        s.replyTo === "f-overflow-locked" &&
        s.status === "error",
    );
    expect(errorResponse).toBeDefined();
    expect(errorResponse.error.code).toBe("SESSION_LIMIT_REACHED");

    const evictedAfter = sent.filter(
      (s: any) =>
        s.type === "event" &&
        s.event === "session.evicted" &&
        sessionKeys.includes(s.data.sessionId),
    );
    expect(evictedAfter).toHaveLength(0);

    broker._resetAskUserBroker();
  });
});
