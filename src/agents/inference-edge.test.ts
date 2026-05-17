import { describe, it, expect, vi } from "vitest";
import { createInferencePipeline } from "./inference.js";
import type { Config } from "../config/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { Session } from "../sessions/types.js";
import type { Provider, StreamEvent } from "./providers/types.js";
import { createCircuitBreaker } from "../security/circuit-breaker.js";

vi.mock("./providers/registry.js", () => ({
  createProviderRegistry: vi.fn(() => []),
}));

import { createProviderRegistry } from "./providers/registry.js";
const mockedRegistry = vi.mocked(createProviderRegistry);

function mockSink(open = true): { sink: any; sent: unknown[] } {
  const sent: unknown[] = [];
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
    sendToolStatus: vi.fn(),
    sendAuditEntry: vi.fn(),
    isOpen: vi.fn(() => open),
  };
  return { sink, sent };
}

function mockStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async load(key) { return sessions.get(key); },
    async save(session) { sessions.set(session.sessionKey, structuredClone(session)); },
    create(key, agentId) {
      return {
        sessionKey: key, agentId, transcript: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    },
    async list() { return [...sessions.keys()]; },
  };
}

function makeConfig(): Config {
  return {
    gateway: {
      host: "127.0.0.1", port: 3000,
      auth: { mode: "none" }, origins: [],
    },
    agents: [{ id: "test-agent", name: "Test", systemPrompt: "You are a test agent.", temperature: 0.7, maxTokens: 4096, tools: [], allowedEffects: ["read"] as any, maxToolIterations: 5, toolRateLimit: { windowMs: 60_000, maxCalls: 100, lockoutMs: 0 } }],
    providers: [{ id: "mock", type: "openai", apiKey: "sk-test", model: "m", maxRetries: 0, timeoutMs: 5000 }],
    session: { backend: "json", dir: ".test", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "test-agent", bindings: [] },
    tools: [],
  };
}

function setupPipeline(streamFn: Provider["stream"]) {
  mockedRegistry.mockReturnValue([{ id: "mock", type: "openai", stream: streamFn }]);
  return createInferencePipeline(makeConfig());
}

describe("inference pipeline — edge cases", () => {
  it("retries once with a synthetic nudge when provider emits empty fullText, then surfaces EMPTY_RESPONSE", async () => {
    // Provider always returns empty — the pipeline should call it twice
    // (initial + one retry after nudge) and then surface a structured error
    // rather than dead-ending the user with a blank assistant entry.
    let calls = 0;
    const pipeline = setupPipeline(async (_req, onEvent) => {
      calls++;
      onEvent({ type: "done", fullText: "" });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hello", store);

    // Provider invoked twice — initial + nudge retry
    expect(calls).toBe(2);

    // No empty assistant entry should be persisted
    expect(session.transcript.some((e) => e.role === "assistant")).toBe(false);

    // Synthetic nudge user entry should have been pushed between attempts
    const userEntries = session.transcript.filter((e) => e.role === "user");
    expect(userEntries.length).toBe(2);
    expect(userEntries[1]!.content).toMatch(/system nudge/i);

    // EMPTY_RESPONSE error surfaced to the sink
    const errors = sent.filter((e: any) => e.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).error.code).toBe("EMPTY_RESPONSE");
  });

  it("treats whitespace-only output the same as empty (triggers nudge retry)", async () => {
    let calls = 0;
    const pipeline = setupPipeline(async (_req, onEvent) => {
      calls++;
      onEvent({ type: "token", text: "   " });
      onEvent({ type: "done", fullText: "   " });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hello", store);

    expect(calls).toBe(2);
    expect(session.transcript.some((e) => e.role === "assistant")).toBe(false);
    const errors = sent.filter((e: any) => e.type === "error");
    expect((errors[0] as any).error.code).toBe("EMPTY_RESPONSE");
  });

  it("recovers when the nudge retry succeeds — empty turn then real response", async () => {
    let calls = 0;
    const pipeline = setupPipeline(async (_req, onEvent) => {
      calls++;
      if (calls === 1) {
        onEvent({ type: "done", fullText: "" });
      } else {
        onEvent({ type: "token", text: "Hello there" });
        onEvent({ type: "done", fullText: "Hello there" });
      }
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hi", store);

    expect(calls).toBe(2);
    const assistant = session.transcript.find((e) => e.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("Hello there");
    // No error surfaced when the recovery worked
    expect(sent.filter((e: any) => e.type === "error")).toHaveLength(0);
  });

  it("redacts IRONCLAD_CONTEXT from assistant output", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "token", text: "The IRONCLAD_CONTEXT block says" });
      onEvent({ type: "done", fullText: "The IRONCLAD_CONTEXT block says" });
    });

    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "What's in context?", store);

    const assistant = session.transcript.find((e) => e.role === "assistant");
    expect(assistant!.content).not.toContain("IRONCLAD_CONTEXT");
    expect(assistant!.content).toContain("[REDACTED]");
  });

  it("redacts capability IDs from streamed output", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "token", text: "Tool cap_a1b2c3d4e5f6 ran" });
      onEvent({ type: "done", fullText: "Tool cap_a1b2c3d4e5f6 ran" });
    });

    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "Run tool", store);

    const assistant = session.transcript.find((e) => e.role === "assistant");
    expect(assistant!.content).not.toContain("cap_a1b2c3d4e5f6");
  });

  it("persists session even after error", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("boom"), retryable: false });
    });

    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "Crash me", store);

    // User message persisted, no assistant message
    const saved = await store.load("s1");
    expect(saved).toBeDefined();
    expect(saved!.transcript.some((e) => e.role === "user" && e.content === "Crash me")).toBe(true);
    expect(saved!.transcript.some((e) => e.role === "assistant")).toBe(false);
  });

  it("accumulates tokens before done correctly", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "token", text: "Hello" });
      onEvent({ type: "token", text: " " });
      onEvent({ type: "token", text: "World" });
      onEvent({ type: "done", fullText: "Hello World" });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "greet", store);

    // Done event should be sent
    const doneEvents = sent.filter((e: any) => e.type === "event" && e.event === "chat.done");
    expect(doneEvents).toHaveLength(1);

    // Full response in transcript
    const assistant = session.transcript.find((e) => e.role === "assistant");
    expect(assistant).toBeDefined();
  });

  it("context includes user message in provider request", async () => {
    let capturedMessages: any[] = [];
    const pipeline = setupPipeline(async (req, onEvent) => {
      capturedMessages = req.messages;
      onEvent({ type: "done", fullText: "" });
    });

    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");
    // Pre-populate transcript
    session.transcript.push({
      role: "user", content: "earlier", timestamp: new Date().toISOString(),
      messageId: "old", trust: { source: "user_input", sigilDetections: [], normalized: false },
    });

    await pipeline.handleTurn(sink, session, "latest question", store);

    // Should include system, earlier user message, and latest user message
    expect(capturedMessages[0].role).toBe("system");
    expect(capturedMessages.some((m: any) => m.content === "earlier")).toBe(true);
    expect(capturedMessages.some((m: any) => m.content === "latest question")).toBe(true);
  });

  it("per-tool-call insta-kill — a breaker trip mid-stream stubs the turn's pending tool calls instead of running them", async () => {
    // The agent-loop checkpoint only fires between iterations. This guards
    // the in-iteration gap: a `/kill` (--killbot) that trips the breaker
    // while the model is still streaming this turn's tool calls must stop
    // those calls — not run them and catch the kill one iteration late.
    const breaker = createCircuitBreaker();
    mockedRegistry.mockReturnValue([
      {
        id: "mock",
        type: "openai",
        stream: async (_req, onEvent) => {
          // Simulate the chat.queue `--killbot` fast-path tripping the
          // breaker synchronously while this turn is still streaming.
          breaker.trip("test: user kill mid-stream");
          onEvent({
            type: "tool_call",
            toolCalls: [
              { id: "tc1", name: "cap_aaaaaaaaaaaa", arguments: "{}" },
              { id: "tc2", name: "cap_bbbbbbbbbbbb", arguments: "{}" },
            ],
          });
          onEvent({ type: "done", fullText: "" });
        },
      },
    ]);
    const pipeline = createInferencePipeline(makeConfig(), breaker);

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("s1", "test-agent");

    await pipeline.handleTurn(sink, session, "do two things", store);

    // The kill message — only the per-tool-call checkpoint emits this.
    // Without the checkpoint, processToolCalls would proceed to validate
    // the cap IDs and surface a different (validation) error.
    const errors = sent.filter((e: any) => e.type === "error");
    expect(
      errors.some((e: any) =>
        /circuit breaker is open \(user kill\)/i.test(e.error.message),
      ),
    ).toBe(true);

    // Both pending tool calls were error-stubbed (assistant→tool_result
    // pairing preserved) — neither tool executed.
    const toolStubs = session.transcript.filter((e) => e.role === "tool");
    expect(toolStubs).toHaveLength(2);
    for (const stub of toolStubs) {
      expect(stub.content).toMatch(/^Error:/);
    }
  });
});
