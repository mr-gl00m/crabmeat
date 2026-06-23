import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { attachMessageHandler } from "../src/gateway/ws/handler.js";
import type { Config } from "../src/config/types.js";
import type { InferencePipeline } from "../src/agents/inference.js";
import type { SessionStore } from "../src/sessions/store.js";
import type { Session } from "../src/sessions/types.js";
import { setWorkspaceRoot } from "../src/agents/tools/builtins.js";

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
        name: "Test",
        systemPrompt: "Test",
        temperature: 0.7,
        maxTokens: 4096,
        tools: [],
        allowedEffects: ["read", "write"],
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
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    readyState: 1,
    OPEN: 1,
  });
  return { ws: ws as any, sent };
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

function pipelineWithStubProvider(text: string): InferencePipeline {
  return {
    handleTurn: vi.fn(async () => {}),
    getProvider: vi.fn(() => undefined),
    getArbiterProviderFn: vi.fn(() => async function* () {
      yield { delta: text };
    }),
  } as unknown as InferencePipeline;
}

describe("Phase 5 E2E: chat → arbiter → file written", () => {
  it("extracts a file_write intent and writes the consultation text to disk", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arbiter-e2e-"));
    setWorkspaceRoot(workspace);

    const expected = "Once upon a time, a crab walked sideways into the sea.";
    const pipeline = pipelineWithStubProvider(expected);
    const { ws, sent } = mockWs();
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "1",
          type: "req",
          method: "chat.send",
          params: { content: "write me a story to story.txt" },
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(pipeline.handleTurn).not.toHaveBeenCalled();

    const written = await readFile(join(workspace, "story.txt"), "utf-8");
    expect(written).toBe(expected);

    const tokens = sent.filter(
      (s: any) => s.type === "event" && s.event === "chat.token",
    );
    expect(tokens.length).toBeGreaterThan(0);
    const tokenText = tokens.map((t: any) => t.data.token).join("");
    expect(tokenText).toMatch(/Wrote/);
    expect(tokenText).toContain("story.txt");
  });

  it("falls through to inference for non-tool chat content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arbiter-e2e-fall-"));
    setWorkspaceRoot(workspace);

    const pipeline = pipelineWithStubProvider("(unused)");
    const { ws } = mockWs();
    attachMessageHandler(ws, makeConfig(), pipeline, mockStore());

    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "1",
          type: "req",
          method: "chat.send",
          params: { content: "what is the weather like today" },
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(pipeline.handleTurn).toHaveBeenCalledTimes(1);
  });
});
