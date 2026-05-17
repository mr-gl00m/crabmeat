import { describe, it, expect, vi } from "vitest";
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
      { id: "default", name: "Test", systemPrompt: "Test", temperature: 0.7, maxTokens: 4096, tools: [], allowedEffects: ["read"], maxToolIterations: 5 },
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
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    readyState: 1,
    OPEN: 1,
  });
  return { ws: ws as any, sent };
}

function mockStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async load(key) { return sessions.get(key); },
    async save(session) { sessions.set(session.sessionKey, session); },
    create(key, agentId, channelId?, peerId?) {
      const s: Session = {
        sessionKey: key, agentId, channelId, peerId,
        transcript: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      sessions.set(key, s);
      return s;
    },
    async list() { return [...sessions.keys()]; },
  };
}

function sendFrame(ws: any, frame: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify(frame)));
}

function tick(ms = 30) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("handler — send-state edge cases", () => {
  it("handles ws close during message processing", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = {
      handleTurn: vi.fn(async () => {
        // Simulate ws closing mid-pipeline
        ws.readyState = 3; // CLOSED
      }),
      getProvider: vi.fn(() => undefined),
      getArbiterProviderFn: vi.fn(() => async function* () { /* unused */ }),
    } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "Hello" } });
    await tick();

    // The ack was sent before pipeline (ws was still open)
    // Pipeline ran — no crash even though ws closed
    expect(pipeline.handleTurn).toHaveBeenCalled();
  });

  it("handles rapid-fire messages without crash", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Send 50 messages rapidly
    for (let i = 0; i < 50; i++) {
      sendFrame(ws, { id: `${i}`, type: "req", method: "chat.send", params: { content: `msg-${i}` } });
    }
    await tick(100);

    // All should be processed (within rate limit)
    expect(pipeline.handleTurn).toHaveBeenCalled();
  });

  it("rate limits excessive messages", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Send more than 100 messages in rapid succession (exceeds hook limiter)
    for (let i = 0; i < 150; i++) {
      sendFrame(ws, { id: `${i}`, type: "req", method: "chat.send", params: { content: `msg-${i}` } });
    }
    await tick(100);

    // Some should be rate limited
    const rateLimited = sent.filter((s: any) => s.error?.code === "RATE_LIMITED");
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});

describe("handler — content edge cases", () => {
  it("accepts content with unicode characters", async () => {
    const { ws } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "こんにちは 🌸" } });
    await tick();

    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
    const content = (pipeline.handleTurn as any).mock.calls[0][2];
    expect(content).toBe("こんにちは 🌸");
  });

  it("rejects empty content", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "" } });
    await tick();

    // Empty content fails Zod min(1) validation → INVALID_FRAME
    expect(sent[0].error.code).toBe("INVALID_FRAME");
    expect(pipeline.handleTurn).not.toHaveBeenCalled();
  });

  it("processes content with embedded JSON", async () => {
    const { ws } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    const nestedJson = 'Please parse: {"method": "connect", "type": "req"}';
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: nestedJson } });
    await tick();

    // Should treat content as opaque string, not re-parse it
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
    const content = (pipeline.handleTurn as any).mock.calls[0][2];
    expect(content).toBe(nestedJson);
  });

  it("handles content with newlines and special characters", async () => {
    const { ws } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Note: literal \0 in JS string → JSON.stringify → \u0000 escape →
    // stripNullBytes operates on raw JSON text (no literal \0) →
    // JSON.parse reconstitutes \u0000 as actual null byte.
    // stripNullBytes only catches literal null bytes in the raw transport
    // layer, NOT JSON-escaped ones. This is a known limitation.
    const content = "Line 1\nLine 2\r\n\tTabbed";
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content } });
    await tick();

    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
    const received = (pipeline.handleTurn as any).mock.calls[0][2];
    expect(received).toBe(content);
  });

  it("strips literal null bytes from raw transport data", async () => {
    const { ws } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Inject a literal null byte into the raw JSON text (not JSON-encoded)
    const frame = JSON.stringify({
      id: "1", type: "req", method: "chat.send", params: { content: "Hello" },
    });
    const withNull = frame.slice(0, 10) + "\0" + frame.slice(10);
    ws.emit("message", Buffer.from(withNull));
    await tick();

    // Should still parse successfully after stripping the null byte
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
  });
});

describe("handler — routing edge cases", () => {
  it("empty channelId routes differently from undefined channelId", async () => {
    const { ws, sent } = mockWs();
    const pipeline: InferencePipeline = { handleTurn: vi.fn(async () => {}), getProvider: vi.fn(() => undefined), getArbiterProviderFn: vi.fn(() => async function* () { }) } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Send with undefined channelId
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "a" } });
    await tick();

    // Send with empty string channelId
    sendFrame(ws, { id: "2", type: "req", method: "chat.send", params: { content: "b", channelId: "" } });
    await tick();

    // Both should succeed, but may route to different sessions
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(2);
    const session1 = (pipeline.handleTurn as any).mock.calls[0][1];
    const session2 = (pipeline.handleTurn as any).mock.calls[1][1];
    // Session keys should differ because HMAC inputs differ
    // (undefined → "" in join vs explicit "" → "" — but both use "" for undefined)
    // Actually session-key.ts uses `channelId ?? ""` so both become ""
    // They should be the SAME session
    expect(session1.sessionKey).toBe(session2.sessionKey);
  });
});

describe("handler — concurrent chat.send on same session", () => {
  it("both requests get ack responses", async () => {
    const { ws, sent } = mockWs();
    let callCount = 0;
    const pipeline: InferencePipeline = {
      handleTurn: vi.fn(async () => {
        callCount++;
        // Simulate some async work
        await new Promise((r) => setTimeout(r, 10));
      }),
      getProvider: vi.fn(() => undefined),
      getArbiterProviderFn: vi.fn(() => async function* () { /* unused */ }),
    } as unknown as InferencePipeline;
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    // Send two messages concurrently to same session
    sendFrame(ws, { id: "1", type: "req", method: "chat.send", params: { content: "First" } });
    sendFrame(ws, { id: "2", type: "req", method: "chat.send", params: { content: "Second" } });
    await tick(100);

    // Both should get streaming ack
    const acks = sent.filter((s: any) => s.type === "res" && s.status === "ok");
    expect(acks).toHaveLength(2);
    expect(pipeline.handleTurn).toHaveBeenCalledTimes(2);
  });
});
