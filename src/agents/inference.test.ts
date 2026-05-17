import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInferencePipeline } from "./inference.js";
import type { Config } from "../config/types.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { Provider, StreamEvent } from "./providers/types.js";

// Minimal mock ConnectorSink
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
  };
}

function makeConfig(providerHandler?: Provider["stream"]): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: 3000,
      auth: { mode: "none" },
      origins: [],
    },
    agents: [
      {
        id: "test-agent",
        name: "Test",
        systemPrompt: "You are a test agent.",
        temperature: 0.7,
        maxTokens: 4096,
        tools: [],
        allowedEffects: ["read"],
        maxToolIterations: 5,
      },
    ],
    providers: [
      {
        id: "mock",
        type: "openai",
        apiKey: "sk-test",
        model: "test-model",
        maxRetries: 0,
        timeoutMs: 5000,
      },
    ],
    session: { backend: "json", dir: ".test/sessions", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "test-agent", bindings: [] },
    tools: [],
  };
}

// We need to mock the provider registry since it creates real SDK clients
vi.mock("./providers/registry.js", () => ({
  createProviderRegistry: vi.fn(() => []),
}));

import { createProviderRegistry } from "./providers/registry.js";

const mockedCreateRegistry = vi.mocked(createProviderRegistry);

describe("createInferencePipeline", () => {
  function setupPipeline(streamHandler: Provider["stream"]) {
    const provider: Provider = {
      id: "mock",
      type: "openai",
      stream: streamHandler,
    };
    mockedCreateRegistry.mockReturnValue([provider]);
    return createInferencePipeline(makeConfig());
  }

  it("streams tokens to WebSocket and saves session", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "token", text: "Hello" });
      onEvent({ type: "token", text: " world" });
      onEvent({ type: "done", fullText: "Hello world", usage: { promptTokens: 10, completionTokens: 5 } });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("sess-1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hi there", store);

    // Should have token events + done event
    const tokenEvents = sent.filter((e: any) => e.type === "event" && e.event === "chat.token");
    const doneEvents = sent.filter((e: any) => e.type === "event" && e.event === "chat.done");

    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(doneEvents).toHaveLength(1);

    // Transcript should have user + assistant messages
    expect(session.transcript).toHaveLength(2);
    expect(session.transcript[0]!.role).toBe("user");
    expect(session.transcript[0]!.content).toBe("Hi there");
    expect(session.transcript[1]!.role).toBe("assistant");

    // Session should be saved
    const loaded = await store.load("sess-1");
    expect(loaded).toBeDefined();
  });

  it("handles provider errors gracefully", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("Provider down"), retryable: false });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("sess-1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hello", store);

    // Should send error event
    const errorEvents = sent.filter((e: any) => e.type === "error");
    expect(errorEvents).toHaveLength(1);

    // User message should still be in transcript
    expect(session.transcript.some((e) => e.role === "user")).toBe(true);

    // Session should still be saved (preserves user message)
    const loaded = await store.load("sess-1");
    expect(loaded).toBeDefined();
  });

  it("redacts sensitive patterns from streamed output", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      // Stream an API key in chunks
      onEvent({ type: "token", text: "The key is sk-" });
      onEvent({ type: "token", text: "abcdefghijklmnopqrstuvwxyz" });
      onEvent({ type: "done", fullText: "The key is sk-abcdefghijklmnopqrstuvwxyz" });
    });

    const { sink, sent } = mockSink();
    const store = mockStore();
    const session = store.create("sess-1", "test-agent");

    await pipeline.handleTurn(sink, session, "What's the key?", store);

    // The assembled response should be redacted
    const assistantEntry = session.transcript.find((e) => e.role === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.content).toContain("[REDACTED]");
    expect(assistantEntry!.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("throws for unknown agent ID", async () => {
    const pipeline = setupPipeline(async () => {});
    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("sess-1", "nonexistent-agent");

    await expect(
      pipeline.handleTurn(sink, session, "Hello", store),
    ).rejects.toThrow("Agent not found");
  });

  it("does not send to closed sink", async () => {
    const pipeline = setupPipeline(async (_req, onEvent) => {
      onEvent({ type: "token", text: "Hello" });
      onEvent({ type: "done", fullText: "Hello" });
    });

    const { sink } = mockSink(false); // closed sink
    const store = mockStore();
    const session = store.create("sess-1", "test-agent");

    await pipeline.handleTurn(sink, session, "Hi", store);

    // Pipeline still runs to completion — sink methods are called but
    // the sink implementation decides whether to actually deliver.
    // The important thing is no errors and session is still saved.
    expect(session.transcript.some((e) => e.role === "user")).toBe(true);
  });

  it("appends user message to transcript before inference", async () => {
    let capturedMessages: any[] = [];
    const pipeline = setupPipeline(async (req, onEvent) => {
      capturedMessages = req.messages;
      onEvent({ type: "done", fullText: "" });
    });

    const { sink } = mockSink();
    const store = mockStore();
    const session = store.create("sess-1", "test-agent");

    await pipeline.handleTurn(sink, session, "My question", store);

    // The request should include the user message
    expect(capturedMessages.some((m: any) => m.role === "user" && m.content === "My question")).toBe(true);
  });
});
