/**
 * Integration tests for the chat.queue WS route.
 *
 * These spin up a real gateway and exercise the interrupt lane end-to-end:
 *   1. SESSION_NOT_ACTIVE when no prior chat.send claimed the session
 *   2. Control kill-token fast path trips the breaker synchronously
 *   3. Queued content is buffered and visible via peekPendingInput
 *   4. Queue full is rejected with QUEUE_FULL
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import type { Config } from "../src/config/types.js";
import WebSocket from "ws";
import {
  _resetPendingInput,
  _listPendingSessions,
  peekPendingInput,
  MAX_PENDING_PER_SESSION,
} from "../src/agents/pending-input.js";

const PORT = 9933;

function cfg(): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: PORT,
      auth: { mode: "none" as const },
      origins: ["http://localhost:*"],
    },
    agents: [
      {
        id: "default",
        name: "T",
        systemPrompt: "test",
        temperature: 0.7,
        maxTokens: 4096,
        charsPerToken: 3.5,
        strictInstructions: false,
        tools: [],
        allowedEffects: ["read"],
        maxToolIterations: 5,
        toolRateLimit: { maxCalls: 20, windowMs: 60_000, lockoutMs: 30_000 },
      },
    ],
    providers: [
      {
        id: "openai",
        type: "openai" as const,
        apiKey: "sk-test",
        model: "gpt-4.1",
        maxRetries: 0,
        timeoutMs: 60_000,
      },
    ],
    session: {
      backend: "json" as const,
      dir: ".crabmeat/sessions-test-queue",
      maxTranscriptEntries: 200,
      retentionDays: 30,
    },
    routing: { defaultAgentId: "default", bindings: [] },
    tools: [],
    layer0: {
      enabled: false,
      allowlist: [],
      confidenceThreshold: 0.7,
      confirmEffects: ["write", "exec", "network", "privileged"],
      forceEscalatePrefix: "ask:",
      showLayerBadge: false,
    },
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

function openWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
}

function waitForMessage(
  s: WebSocket,
  predicate: (m: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for message")),
      timeoutMs,
    );
    const onMsg = (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (predicate(m)) {
        clearTimeout(timer);
        s.off("message", onMsg);
        resolve(m);
      }
    };
    s.on("message", onMsg);
  });
}

async function handshake(s: WebSocket): Promise<void> {
  const id = crypto.randomUUID();
  s.send(
    JSON.stringify({
      id,
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    }),
  );
  await waitForMessage(s, (m) => m.replyTo === id && m.status === "ok");
}

async function send(
  s: WebSocket,
  method: string,
  params: unknown,
): Promise<any> {
  const id = crypto.randomUUID();
  const p = waitForMessage(s, (m) => m.type === "res" && m.replyTo === id);
  s.send(JSON.stringify({ id, type: "req", method, params }));
  return p;
}

describe("chat.queue interrupt lane", () => {
  let gw: Gateway;

  beforeEach(() => {
    _resetPendingInput();
  });

  afterEach(async () => {
    if (gw) await gw.stop();
  });

  it("rejects chat.queue without an active session", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs();
    await handshake(s);

    const res = await send(s, "chat.queue", { content: "hello" });
    expect(res.status).toBe("error");
    expect(res.error.code).toBe("SESSION_NOT_ACTIVE");
    s.close();
  });

  it("fast-paths a control kill token and trips the breaker", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs();
    await handshake(s);

    // Claim the session by starting a chat.send. We don't care about
    // the streaming content — just that the connection now owns the
    // default session key. We use a control token in chat.send so it
    // returns synchronously without hitting inference.
    await send(s, "chat.send", { content: "--bothelp" });

    expect(gw.circuitBreaker.isAllowed()).toBe(true);

    const res = await send(s, "chat.queue", { content: "--killbot" });
    expect(res.status).toBe("ok");
    expect(res.data.kind).toBe("control");
    expect(res.data.breakerTripped).toBe(true);
    expect(gw.circuitBreaker.isAllowed()).toBe(false);

    s.close();
  });

  it("enqueues normal content and reflects it in the pending buffer", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs();
    await handshake(s);

    // Claim session ownership via --bothelp (no inference side effects).
    await send(s, "chat.send", { content: "--bothelp" });

    const res = await send(s, "chat.queue", { content: "also check the logs" });
    expect(res.status).toBe("ok");
    expect(res.data.kind).toBe("queued");
    expect(res.data.position).toBe(1);

    // We don't know the exact session key the gateway routed to, so
    // iterate all keys with pending content — there should be exactly
    // one since this is a fresh test.
    const keys = _listPendingSessions();
    expect(keys.length).toBe(1);
    const entries = peekPendingInput(keys[0]!);
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe("also check the logs");

    s.close();
  });

  it("returns QUEUE_FULL when the per-session buffer is saturated", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs();
    await handshake(s);
    await send(s, "chat.send", { content: "--bothelp" });

    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      const r = await send(s, "chat.queue", { content: `msg-${i}` });
      expect(r.status).toBe("ok");
    }
    const overflow = await send(s, "chat.queue", { content: "nope" });
    expect(overflow.status).toBe("error");
    expect(overflow.error.code).toBe("QUEUE_FULL");

    s.close();
  });

  it("rejects empty content at the schema level", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs();
    await handshake(s);
    await send(s, "chat.send", { content: "--bothelp" });

    const res = await send(s, "chat.queue", { content: "" });
    expect(res.status).toBe("error");
    // Empty content is rejected inside the handler (not at the frame
    // schema level) so the client gets a proper error *response* with
    // replyTo instead of a top-level error event.
    expect(res.error.code).toBe("EMPTY_INPUT");
    s.close();
  });
});

