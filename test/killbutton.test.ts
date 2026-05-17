/**
 * Kill Button & Circuit Breaker Tests
 *
 * Tests for: circuit breaker trip/reset, admin endpoints (kill + circuit breaker),
 * auth on admin endpoints, localhost provider SSRF exception.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { createCircuitBreaker } from "../src/security/circuit-breaker.js";
import {
  issueKillToken,
  _resetKillTokens,
} from "../src/security/kill-tokens.js";
import { configSchema, isSafeBaseUrl } from "../src/config/schema.js";
import type { Config } from "../src/config/types.js";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import http from "node:http";

const ADMIN_TOKEN = "admin-secret-token-xK9mL2wQ-vN7yT-pZc8d";

function cfg(overrides: Partial<{
  adminEnabled: boolean;
  adminToken: string;
  allowLocal: boolean;
  port: number;
}>= {}): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: overrides.port ?? 0,
      auth: { mode: "none" as const },
      origins: ["http://localhost:*"],
    },
    agents: [{ id: "default", name: "T", systemPrompt: "test", temperature: 0.7, maxTokens: 4096, tools: [], allowedEffects: ["read"], maxToolIterations: 5 }],
    providers: [{ id: "openai", type: "openai" as const, apiKey: "sk-test", model: "gpt-4.1", maxRetries: 2, timeoutMs: 60_000 }],
    session: { backend: "json" as const, dir: ".crabmeat/sessions-test-killbutton", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "default", bindings: [] },
    tools: [],
    audit: { enabled: true, maxEntries: 10_000 },
    admin: { enabled: overrides.adminEnabled ?? true, token: overrides.adminToken ?? ADMIN_TOKEN },
    allowLocalProviders: overrides.allowLocal ?? false,
  } as Config;
}

function getPort(gw: Gateway): number {
  return (gw.server.address() as AddressInfo).port;
}

function httpReq(port: number, method: string, path: string, opts?: { body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    if (opts?.body) req.write(opts.body);
    req.end();
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

// ────────────────────────────────────────────────────────
//  Circuit Breaker — Unit Tests
// ────────────────────────────────────────────────────────
describe("Circuit Breaker", () => {
  it("starts in closed state (requests allowed)", () => {
    const cb = createCircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.isAllowed()).toBe(true);
  });

  it("blocks requests when tripped", () => {
    const cb = createCircuitBreaker();
    cb.trip("test");
    expect(cb.state).toBe("open");
    expect(cb.isAllowed()).toBe(false);
  });

  it("allows requests after reset", () => {
    const cb = createCircuitBreaker();
    cb.trip("test");
    expect(cb.isAllowed()).toBe(false);
    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.isAllowed()).toBe(true);
  });

  it("trip is idempotent", () => {
    const cb = createCircuitBreaker();
    cb.trip("first");
    cb.trip("second");
    expect(cb.state).toBe("open");
  });

  it("reset is idempotent", () => {
    const cb = createCircuitBreaker();
    cb.reset(); // already closed
    expect(cb.state).toBe("closed");
  });
});

// ────────────────────────────────────────────────────────
//  Circuit Breaker — WebSocket Integration
// ────────────────────────────────────────────────────────
describe("Circuit Breaker — WebSocket rejection", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop().catch(() => {}); });

  it("rejects new WebSocket connections when circuit breaker is open", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);

    // Trip the breaker
    gw.circuitBreaker.trip("test");

    // Try connecting — should be closed immediately
    const ws = await connectWs(port);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4503);
    expect(reason).toContain("circuit breaker");
  });

  it("accepts connections after circuit breaker is reset", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);

    gw.circuitBreaker.trip("test");
    gw.circuitBreaker.reset();

    // Should connect successfully
    const ws = await connectWs(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ────────────────────────────────────────────────────────
//  Admin Endpoint — Authentication
// ────────────────────────────────────────────────────────
describe("Admin endpoints — authentication", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop().catch(() => {}); });

  it("rejects admin kill without auth header", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/kill");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("rejects admin kill with wrong token", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/kill", {
      headers: { Authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxx" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects GET on admin kill endpoint", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "GET", "/admin/kill", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it("admin endpoints return 404 when admin is disabled", async () => {
    gw = createGateway(cfg({ adminEnabled: false }));
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/kill", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────
//  Admin Endpoint — Circuit Breaker Control
// ────────────────────────────────────────────────────────
describe("Admin endpoint — circuit breaker control", () => {
  let gw: Gateway;
  afterEach(async () => { if (gw) await gw.stop().catch(() => {}); });

  it("GET /admin/circuit-breaker requires auth and returns current state", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    // Without auth → 401
    const noAuth = await httpReq(port, "GET", "/admin/circuit-breaker");
    expect(noAuth.status).toBe(401);
    // With auth → 200
    const res = await httpReq(port, "GET", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("closed");
  });

  it("POST trip requires auth", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/circuit-breaker", {
      body: JSON.stringify({ action: "trip" }),
    });
    expect(res.status).toBe(401);
  });

  it("trips circuit breaker with valid auth", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ action: "trip" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("open");

    // Verify state persisted via GET (with auth)
    const check = await httpReq(port, "GET", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(check.body.state).toBe("open");
  });

  it("resets circuit breaker with valid auth", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);

    // Trip first
    await httpReq(port, "POST", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ action: "trip" }),
    });

    // Reset
    const res = await httpReq(port, "POST", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ action: "reset" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("closed");
  });

  it("rejects invalid action", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ action: "explode" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("trip");
  });

  it("rejects invalid JSON body", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReq(port, "POST", "/admin/circuit-breaker", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: "not json{{{",
    });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────
//  Local Provider SSRF Exception (Ollama)
// ────────────────────────────────────────────────────────
describe("allowLocalProviders — localhost SSRF exception", () => {
  it("isSafeBaseUrl blocks localhost by default", () => {
    expect(isSafeBaseUrl("http://localhost:11434/v1")).toBe(false);
    expect(isSafeBaseUrl("http://127.0.0.1:11434/v1")).toBe(false);
  });

  it("isSafeBaseUrl allows localhost when allowLocal=true", () => {
    expect(isSafeBaseUrl("http://localhost:11434/v1", true)).toBe(true);
    expect(isSafeBaseUrl("http://127.0.0.1:11434/v1", true)).toBe(true);
    expect(isSafeBaseUrl("http://[::1]:11434/v1", true)).toBe(true);
  });

  it("still blocks private ranges even with allowLocal=true", () => {
    expect(isSafeBaseUrl("http://10.0.0.1:8080", true)).toBe(false);
    expect(isSafeBaseUrl("http://192.168.1.1:8080", true)).toBe(false);
    expect(isSafeBaseUrl("http://172.16.0.1:8080", true)).toBe(false);
  });

  it("still blocks cloud metadata even with allowLocal=true", () => {
    expect(isSafeBaseUrl("http://169.254.169.254/latest/meta-data", true)).toBe(false);
    expect(isSafeBaseUrl("http://metadata.google.internal", true)).toBe(false);
  });

  it("still blocks 0.0.0.0 even with allowLocal=true", () => {
    expect(isSafeBaseUrl("http://0.0.0.0:11434", true)).toBe(false);
  });

  it("config schema rejects localhost provider without allowLocalProviders", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "ollama", type: "openai", apiKey: "ollama", model: "gpt-oss", baseUrl: "http://localhost:11434/v1" }],
    });
    expect(result.success).toBe(false);
  });

  it("config schema accepts localhost provider with allowLocalProviders: true", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "ollama", type: "openai", apiKey: "ollama", model: "gpt-oss", baseUrl: "http://localhost:11434/v1" }],
      allowLocalProviders: true,
    });
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
//  Admin Config Validation
// ────────────────────────────────────────────────────────
describe("Admin config validation", () => {
  it("rejects admin.enabled=true without token", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "o", type: "openai", apiKey: "sk-test", model: "m" }],
      admin: { enabled: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects admin token shorter than 32 chars", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "o", type: "openai", apiKey: "sk-test", model: "m" }],
      admin: { enabled: true, token: "short" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts admin with valid token", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "o", type: "openai", apiKey: "sk-test", model: "m" }],
      admin: { enabled: true, token: "admin-token-xK9mL2wQ-vN7yT-pZc8d!!" },
    });
    expect(result.success).toBe(true);
  });

  it("admin defaults to disabled when omitted", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "o", type: "openai", apiKey: "sk-test", model: "m" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.admin.enabled).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────
//  Kill-Token Endpoint (stage-a smoke: /admin/kill-token)
// ────────────────────────────────────────────────────────

function httpReqRaw(port: number, path: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Kill-Token Endpoint", () => {
  let gw: Gateway;
  afterEach(async () => {
    if (gw) await gw.stop().catch(() => {});
    _resetKillTokens();
  });

  it("is available even when admin endpoints are disabled", async () => {
    gw = createGateway(cfg({ adminEnabled: false }));
    await gw.start();
    const port = getPort(gw);
    // No token param → 404 (not 405, which would mean the route is gated)
    const res = await httpReqRaw(port, "/admin/kill-token");
    expect(res.status).toBe(404);
    expect(res.body).toContain("not valid");
  });

  it("trips the circuit breaker on valid redemption", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);

    expect(gw.circuitBreaker.state).toBe("closed");
    const token = issueKillToken("test-session", "running amok");
    const res = await httpReqRaw(port, `/admin/kill-token?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("stopped");
    expect(gw.circuitBreaker.state).toBe("open");
  });

  it("second redemption of the same token fails and does not re-trip", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);

    const token = issueKillToken("test-session", "r");
    await httpReqRaw(port, `/admin/kill-token?t=${token}`);
    gw.circuitBreaker.reset();
    const res = await httpReqRaw(port, `/admin/kill-token?t=${token}`);
    expect(res.status).toBe(404);
    expect(gw.circuitBreaker.state).toBe("closed");
  });

  it("rejects non-GET methods with 405", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const token = issueKillToken("test-session", "r");
    const res = await httpReqRaw(port, `/admin/kill-token?t=${token}`, "POST");
    expect(res.status).toBe(405);
    expect(gw.circuitBreaker.state).toBe("closed");
  });

  it("returns 404 for unknown/malformed token without tripping", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const res = await httpReqRaw(port, `/admin/kill-token?t=${"a".repeat(48)}`);
    expect(res.status).toBe(404);
    expect(gw.circuitBreaker.state).toBe("closed");
  });

  it("returns HTML with noindex meta and does not echo the token", async () => {
    gw = createGateway(cfg());
    await gw.start();
    const port = getPort(gw);
    const token = issueKillToken("test-session", "r");
    const res = await httpReqRaw(port, `/admin/kill-token?t=${token}`);
    expect(res.body).toContain("noindex");
    expect(res.body).not.toContain(token);
  });
});
