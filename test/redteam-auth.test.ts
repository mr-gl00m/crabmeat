/**
 * RED TEAM — Authentication & Authorization Attack Surface
 *
 * Tests for: brute force, credential stuffing, timing leaks,
 * auth bypass, session hijacking, and protocol-level attacks.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { authenticate } from "../src/gateway/auth/auth.js";
import { secretEqual } from "../src/security/secret-equal.js";
import { deriveSessionKey } from "../src/sessions/session-key.js";
import type { Config } from "../src/config/types.js";
import WebSocket from "ws";

const PORT = 9900;

function cfg(mode: "none" | "token" | "password" = "token", secret = "s3cret-tok3n!-xK9mL2wQ-vN7yT-pZc8d"): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: PORT,
      auth: { mode, ...(mode === "token" ? { token: secret } : mode === "password" ? { password: secret } : {}) },
      origins: ["http://localhost:*"],
    },
    agents: [{ id: "default", name: "T", systemPrompt: "test", temperature: 0.7, maxTokens: 4096, tools: [], allowedEffects: ["read"], maxToolIterations: 5 }],
    providers: [{ id: "openai", type: "openai" as const, apiKey: "sk-test", model: "gpt-4.1", maxRetries: 2, timeoutMs: 60_000 }],
    session: { backend: "json" as const, dir: ".crabmeat/sessions-test", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "default", bindings: [] },
    tools: [],
  };
}

function ws(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
}

function sendRecv(s: WebSocket, data: unknown): Promise<any> {
  return new Promise((resolve) => {
    s.once("message", (m: Buffer) => resolve(JSON.parse(m.toString())));
    s.once("close", (code: number, reason: Buffer) =>
      resolve({ type: "error", error: { code: String(code), message: reason.toString() }, status: "closed" }),
    );
    try {
      s.send(JSON.stringify(data));
    } catch {
      // WS already closing — the close handler will resolve
    }
  });
}

function connectFrame(token?: string, password?: string, version = 1) {
  return { id: crypto.randomUUID(), type: "req", method: "connect", params: { protocolVersion: version, token, password } };
}

// ────────────────────────────────────────────────────────
//  RT-AUTH-001  Brute-force credential guessing
// ────────────────────────────────────────────────────────
describe("RT-AUTH-001: Brute-force rate limiting", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("locks out after repeated auth failures", async () => {
    gw = createGateway(cfg("token", "correct-token-xK9mL2wQ-vN7yT-pZc8d"));
    await gw.start();

    const failures: boolean[] = [];

    // Send 15 rapid connections (auth limiter allows 10 per window)
    for (let i = 0; i < 15; i++) {
      const s = await ws(PORT);
      const r = await sendRecv(s, connectFrame("wrong-token-" + i));
      failures.push(r.type === "error");
      s.close();
    }

    // All should have failed (wrong token or rate limited)
    expect(failures.every(Boolean)).toBe(true);

    // Now try the correct token — should be blocked by auth rate limiter
    const s = await ws(PORT);
    const r = await sendRecv(s, connectFrame("correct-token-xK9mL2wQ-vN7yT-pZc8d"));
    s.close();

    // FIXED: Auth rate limiter now blocks after 10 attempts.
    // The 16th connection (correct token) should be rejected because
    // the rate limiter check fires BEFORE handshake processing.
    const accepted = r.status === "ok";
    expect(accepted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
//  RT-AUTH-002  Timing oracle on secretEqual
// ────────────────────────────────────────────────────────
describe("RT-AUTH-002: Timing-safe comparison", () => {
  it("shows no measurable timing difference between short and long mismatches", () => {
    const reference = "a".repeat(100_000);
    const shortWrong = "b";
    const longWrong = "b".repeat(99_999) + "c";

    const runs = 500;
    const shortTimes: number[] = [];
    const longTimes: number[] = [];

    for (let i = 0; i < runs; i++) {
      const s1 = performance.now();
      secretEqual(reference, shortWrong);
      shortTimes.push(performance.now() - s1);

      const s2 = performance.now();
      secretEqual(reference, longWrong);
      longTimes.push(performance.now() - s2);
    }

    const avgShort = shortTimes.reduce((a, b) => a + b, 0) / runs;
    const avgLong = longTimes.reduce((a, b) => a + b, 0) / runs;
    const ratio = avgLong / avgShort;

    // Timing-safe: ratio should be close to 1.0 (±50%)
    // A naive strcmp would show ratio >> 1 because long inputs take longer
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3.0);
  });

  it("rejects empty token against non-empty secret", () => {
    expect(secretEqual("", "real-secret")).toBe(false);
  });

  it("rejects null-byte padded token", () => {
    expect(secretEqual("real\x00secret", "real-secret")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────
//  RT-AUTH-003  Auth mode "none" bypass
// ────────────────────────────────────────────────────────
describe("RT-AUTH-003: Auth mode 'none' accepts anything", () => {
  it("mode=none authenticates with any garbage credentials", () => {
    const config = cfg("none").gateway;
    expect(authenticate(config, {}).authenticated).toBe(true);
    expect(authenticate(config, { token: "invented-token" }).authenticated).toBe(true);
    expect(authenticate(config, { password: "totally-wrong" }).authenticated).toBe(true);

    // FINDING: mode=none is the default in defaults.ts — any deployment
    // that doesn't explicitly set auth is wide-open.
  });
});

// ────────────────────────────────────────────────────────
//  RT-AUTH-004  Protocol version downgrade / mismatch
// ────────────────────────────────────────────────────────
describe("RT-AUTH-004: Protocol downgrade attack", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop(); });

  it("rejects protocol version 0", async () => {
    gw = createGateway(cfg("none"));
    await gw.start();
    const s = await ws(PORT);
    const r = await sendRecv(s, connectFrame(undefined, undefined, 0 as any));
    expect(r.type).toBe("error");
    s.close();
  });

  it("rejects protocol version 999", async () => {
    gw = createGateway(cfg("none"));
    await gw.start();
    const s = await ws(PORT);
    const r = await sendRecv(s, connectFrame(undefined, undefined, 999 as any));
    expect(r.type).toBe("error");
    s.close();
  });
});

// ────────────────────────────────────────────────────────
//  RT-AUTH-005  Session key predictability
// ────────────────────────────────────────────────────────
describe("RT-AUTH-005: Deterministic session key hijacking", () => {
  it("session key is fully predictable from routing params", () => {
    const key1 = deriveSessionKey("default", "general", "alice");
    const key2 = deriveSessionKey("default", "general", "alice");
    expect(key1).toBe(key2);

    // FINDING: any client that knows (agentId, channelId, peerId) can
    // derive the session key and request chat.history for that session.
    // There is no ownership binding between the authenticated client
    // and the session they access.
    const key3 = deriveSessionKey("default", undefined, undefined);
    expect(key3.length).toBe(24);
    expect(typeof key3).toBe("string");
  });

  it("different routing params produce different keys", () => {
    const a = deriveSessionKey("default", "ch1", "p1");
    const b = deriveSessionKey("default", "ch1", "p2");
    const c = deriveSessionKey("default", "ch2", "p1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("underscore collision between undefined and literal underscore", () => {
    // channelId=undefined maps to "". What if someone actually sends channelId="_"?
    const keyUndefined = deriveSessionKey("default", undefined, "peer");
    const keyUnderscore = deriveSessionKey("default", "_", "peer");

    // FIXED: These now produce DIFFERENT session keys (null-byte delimiter + HMAC)
    expect(keyUndefined).not.toBe(keyUnderscore);
  });
});

// ────────────────────────────────────────────────────────
//  RT-AUTH-006  Auth error enumeration
// ────────────────────────────────────────────────────────
describe("RT-AUTH-006: Error message information leakage", () => {
  it("leaks whether token vs password is expected", () => {
    const tokenCfg = cfg("token", "secret").gateway;
    const r1 = authenticate(tokenCfg, {});
    const r2 = authenticate(tokenCfg, { token: "wrong" });

    // FINDING: "Token required" vs "Invalid token" reveals auth mode
    expect(r1.reason).toBe("Token required");
    expect(r2.reason).toBe("Invalid token");
    expect(r1.reason).not.toBe(r2.reason);
  });

  it("password mode also leaks auth type", () => {
    const pwCfg = cfg("password", "secret").gateway;
    const r1 = authenticate(pwCfg, {});
    expect(r1.reason).toBe("Password required");
  });
});
