import { describe, it, expect, afterEach } from "vitest";
import { createGateway, type Gateway } from "./server.js";
import type { Config } from "../config/types.js";
import WebSocket from "ws";

const TEST_PORT = 9876;

function testConfig(authMode: "none" | "token" = "none", token?: string): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: TEST_PORT,
      auth: { mode: authMode, token },
      origins: ["http://localhost:*"],
    },
    agents: [
      {
        id: "default",
        name: "Test Agent",
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
        id: "openai",
        type: "openai",
        apiKey: "sk-test",
        model: "gpt-4.1",
        maxRetries: 2,
        timeoutMs: 60_000,
      },
    ],
    session: {
      backend: "json",
      dir: ".crabmeat/sessions",
      maxTranscriptEntries: 200,
      retentionDays: 30,
    },
    routing: {
      defaultAgentId: "default",
      bindings: [],
    },
    tools: [],
  };
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendAndReceive(ws: WebSocket, data: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (msg: Buffer) => {
      resolve(JSON.parse(msg.toString()));
    });
    ws.send(JSON.stringify(data));
  });
}

describe("Gateway", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) await gateway.stop();
  });

  it("responds to /health", async () => {
    gateway = createGateway(testConfig());
    await gateway.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("returns security headers on HTTP responses", async () => {
    gateway = createGateway(testConfig());
    await gateway.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for unknown routes", async () => {
    gateway = createGateway(testConfig());
    await gateway.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("accepts authenticated WebSocket connection (mode=none)", async () => {
    gateway = createGateway(testConfig());
    await gateway.start();

    const ws = await connectWs(TEST_PORT);
    const response = await sendAndReceive(ws, {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    });

    expect(response).toMatchObject({
      type: "res",
      replyTo: "1",
      status: "ok",
      data: { protocolVersion: 1, status: "connected" },
    });

    ws.close();
  });

  it("accepts WebSocket connection with valid token", async () => {
    gateway = createGateway(testConfig("token", "my-secret"));
    await gateway.start();

    const ws = await connectWs(TEST_PORT);
    const response = await sendAndReceive(ws, {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1, token: "my-secret" },
    });

    expect(response).toMatchObject({
      type: "res",
      status: "ok",
    });

    ws.close();
  });

  it("rejects WebSocket connection with invalid token", async () => {
    gateway = createGateway(testConfig("token", "my-secret"));
    await gateway.start();

    const ws = await connectWs(TEST_PORT);
    const response = await sendAndReceive(ws, {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1, token: "wrong-token" },
    });

    expect(response).toMatchObject({
      type: "error",
      error: { code: "AUTH_FAILED" },
    });
  });

  it("handles post-auth chat.send (stub)", async () => {
    gateway = createGateway(testConfig());
    await gateway.start();

    const ws = await connectWs(TEST_PORT);

    // Handshake
    await sendAndReceive(ws, {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    });

    // Send a chat message
    const response = await sendAndReceive(ws, {
      id: "2",
      type: "req",
      method: "chat.send",
      params: { content: "Hello, agent!" },
    });

    expect(response).toMatchObject({
      type: "res",
      replyTo: "2",
      status: "ok",
    });

    ws.close();
  });
});
