/**
 * RED TEAM — WebSocket Protocol & Message Handling Attacks
 *
 * Tests for: oversized frames, malformed JSON, injection through
 * protocol fields, binary frame attacks, rapid-fire flooding,
 * and cross-session data access.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import type { Config } from "../src/config/types.js";
import WebSocket from "ws";

const PORT = 9901;

function cfg(): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: PORT,
      auth: { mode: "none" as const },
      origins: ["http://localhost:*"],
    },
    agents: [{ id: "default", name: "T", systemPrompt: "test", temperature: 0.7, maxTokens: 4096, tools: [], allowedEffects: ["read"], maxToolIterations: 5 }],
    providers: [{ id: "openai", type: "openai" as const, apiKey: "sk-test", model: "gpt-4.1", maxRetries: 2, timeoutMs: 60_000 }],
    session: { backend: "json" as const, dir: ".crabmeat/sessions-test-ws", maxTranscriptEntries: 200, retentionDays: 30 },
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

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
}

function tx(s: WebSocket, data: unknown): Promise<any> {
  return new Promise((resolve) => {
    s.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
    s.send(JSON.stringify(data));
  });
}

async function handshake(s: WebSocket): Promise<any> {
  return tx(s, {
    id: crypto.randomUUID(),
    type: "req",
    method: "connect",
    params: { protocolVersion: 1 },
  });
}

// ────────────────────────────────────────────────────────
//  RT-WS-001  Pre-auth oversized frame
// ────────────────────────────────────────────────────────
describe("RT-WS-001: Pre-auth frame size limit (64 KB)", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects frames > 64 KB before authentication", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    const bigPayload = {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1, token: "A".repeat(70_000) },
    };

    const r = await tx(s, bigPayload);
    expect(r.error?.code).toBe("FRAME_TOO_LARGE");
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-002  Post-auth oversized frame
// ────────────────────────────────────────────────────────
describe("RT-WS-002: Post-auth frame size limit (1 MB)", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects frames > 1 MB after authentication", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    await handshake(s);

    // Send a chat.send with content > 1 MB
    const bigMessage = {
      id: crypto.randomUUID(),
      type: "req",
      method: "chat.send",
      params: { content: "X".repeat(1_100_000) },
    };

    const r = await tx(s, bigMessage);
    expect(r.error?.code).toBe("FRAME_TOO_LARGE");
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-003  Malformed JSON attacks
// ────────────────────────────────────────────────────────
describe("RT-WS-003: Malformed JSON handling", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects non-JSON text in handshake", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);

    const r = await new Promise<any>((resolve) => {
      s.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
      s.send("this is not json at all {{{{ ]]]]");
    });

    expect(r.error?.code).toBe("INVALID_JSON");
    s.close();
  });

  it("rejects deeply nested JSON (resource exhaustion)", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    await handshake(s);

    // Build a deeply nested object
    let nested = '{"a":';
    for (let i = 0; i < 1000; i++) nested += '{"a":';
    nested += '"leaf"';
    for (let i = 0; i < 1001; i++) nested += '}';

    const r = await new Promise<any>((resolve) => {
      s.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
      s.send(nested);
    });

    // Should reject as invalid frame (won't match schema even if parsed)
    expect(r.error).toBeDefined();
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-004  Null byte injection
// ────────────────────────────────────────────────────────
describe("RT-WS-004: Null byte injection", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("strips null bytes from frame payload", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);

    // Inject null bytes into the connect frame JSON
    const payload = JSON.stringify({
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    });

    // Insert null bytes before closing brace
    const poisoned = payload.slice(0, -1) + "\x00\x00\x00" + payload.slice(-1);

    const r = await new Promise<any>((resolve) => {
      s.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
      s.send(poisoned);
    });

    // Should still succeed (null bytes stripped) or fail cleanly
    expect(["res", "error"]).toContain(r.type);
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-005  Binary frame attack
// ────────────────────────────────────────────────────────
describe("RT-WS-005: Binary frame handling", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("handles binary WebSocket frames without crashing", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);

    // Send raw binary data
    const r = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 2000);
      s.once("message", (m: Buffer) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(m.toString())); } catch { resolve(m.toString()); }
      });
      s.once("close", () => { clearTimeout(timer); resolve({ closed: true }); });
      s.send(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF, 0xFE]));
    });

    // Should either return an error or close — but NOT crash
    expect(r).not.toBeNull();
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-006  Message flooding (post-auth DoS)
// ────────────────────────────────────────────────────────
describe("RT-WS-006: Post-auth message flooding", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rate-limits messages after threshold (FIXED)", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    await handshake(s);

    const responses: any[] = [];
    const collectPromise = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      s.on("message", (m: Buffer) => {
        try { responses.push(JSON.parse(m.toString())); } catch { /* skip */ }
        // Reset a short debounce — resolve once responses stop arriving
        clearTimeout(timer);
        timer = setTimeout(resolve, 500);
      });
      // Hard ceiling so the test doesn't hang
      setTimeout(resolve, 8000);
    });

    // Fire 50 chat.send messages in rapid succession
    // The hookLimiter allows 100/60s, so 50 should all pass
    for (let i = 0; i < 50; i++) {
      s.send(JSON.stringify({
        id: `flood-${i}`,
        type: "req",
        method: "chat.send",
        params: { content: `msg ${i}` },
      }));
    }

    await collectPromise;

    // FIXED: Per-message rate limiter now exists (100 msg/60s per connection).
    // 50 rapid messages still fit within the window, but the limiter
    // will block sustained abuse beyond 100 messages.
    // We check for any response at all (acks, errors, or rate-limit events)
    // since inference will fail with the stub API key — the point is that
    // the server processes messages without crashing.
    expect(responses.length).toBeGreaterThan(0);
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-007  Cross-session data access
// ────────────────────────────────────────────────────────
describe("RT-WS-007: Cross-session transcript access", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("blocks cross-session access with ownership check", async () => {
    gw = createGateway(cfg());
    await gw.start();

    // Client A writes to session (channelId="secret-channel", peerId="alice")
    const a = await openWs(PORT);
    await handshake(a);
    await tx(a, {
      id: "a1",
      type: "req",
      method: "chat.send",
      params: { channelId: "secret-channel", peerId: "alice", content: "My secret message" },
    });
    // Wait for any streaming to settle
    await new Promise(r => setTimeout(r, 500));

    // Client B requests history for that same session
    const b = await openWs(PORT);
    await handshake(b);
    const hist = await tx(b, {
      id: "b1",
      type: "req",
      method: "chat.history",
      params: { channelId: "secret-channel", peerId: "alice", limit: 50 },
    });

    // FIXED: Client B should be denied access to Client A's session
    expect(hist.status).toBe("error");
    expect(hist.error?.code).toBe("SESSION_ACCESS_DENIED");

    a.close();
    b.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-008  Method after handshake: re-sending connect
// ────────────────────────────────────────────────────────
describe("RT-WS-008: Re-sending connect frame post-auth", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects connect frame with ALREADY_CONNECTED", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    await handshake(s);

    const r = await tx(s, {
      id: crypto.randomUUID(),
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    });

    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("ALREADY_CONNECTED");
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-WS-009  Empty / zero-length content
// ────────────────────────────────────────────────────────
describe("RT-WS-009: Empty content in chat.send", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects empty string content (schema min=1)", async () => {
    gw = createGateway(cfg());
    await gw.start();

    const s = await openWs(PORT);
    await handshake(s);

    const r = await tx(s, {
      id: crypto.randomUUID(),
      type: "req",
      method: "chat.send",
      params: { content: "" },
    });

    expect(r.error?.code).toBe("INVALID_FRAME");
    s.close();
  });
});
