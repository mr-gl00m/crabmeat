import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleKillToken, handleCircuitBreaker, handleAdminKill, type AdminContext } from "./admin.js";
import {
  issueKillToken,
  _resetKillTokens,
} from "../../security/kill-tokens.js";
import { createCircuitBreaker } from "../../security/circuit-breaker.js";
import { createAuditLog, type AuditLog } from "../../security/audit.js";

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  writeHead(code: number, headers?: Record<string, string>): MockRes;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
  readonly res: ServerResponse;
}

function mockReq(url: string, method = "GET"): IncomingMessage {
  return {
    url,
    method,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function mockRes(): MockRes {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
  };
  const obj: MockRes = {
    get statusCode() {
      return state.statusCode;
    },
    get headers() {
      return state.headers;
    },
    get body() {
      return state.body;
    },
    get ended() {
      return state.ended;
    },
    writeHead(code, headers) {
      state.statusCode = code;
      if (headers) Object.assign(state.headers, headers);
      return obj;
    },
    setHeader(k, v) {
      state.headers[k] = v;
    },
    end(body) {
      state.body = body ?? "";
      state.ended = true;
    },
    get res() {
      return obj as unknown as ServerResponse;
    },
  };
  return obj;
}

function makeCtx(opts?: { adminToken?: string; auditLog?: AuditLog }): AdminContext {
  return {
    adminToken: opts?.adminToken ?? "",
    circuitBreaker: createCircuitBreaker(),
    auditLog: opts?.auditLog ?? createAuditLog(),
    shutdownFn: async () => {},
  };
}

function mockReqWithAuth(url: string, method: string, token: string, body?: string): IncomingMessage {
  const chunks: Buffer[] = body ? [Buffer.from(body)] : [];
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const req = {
    url,
    method,
    headers: { host: "localhost", authorization: `Bearer ${token}` },
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, fn: (arg: unknown) => void) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    destroy() {},
  } as unknown as IncomingMessage & { triggerStream(): void };
  // Drive the data/end listeners synchronously when the handler subscribes.
  setImmediate(() => {
    for (const fn of listeners["data"] ?? []) {
      for (const c of chunks) fn(c);
    }
    for (const fn of listeners["end"] ?? []) fn(undefined);
  });
  return req;
}

describe("handleKillToken", () => {
  beforeEach(() => {
    _resetKillTokens();
  });

  it("rejects non-GET methods with 405", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const res = mockRes();
    await handler(mockReq("/admin/kill-token?t=abc", "POST"), res.res);
    expect(res.statusCode).toBe(405);
    ctx.circuitBreaker.destroy();
  });

  it("returns 404 when no token query param is present", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const res = mockRes();
    await handler(mockReq("/admin/kill-token"), res.res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not valid");
    expect(ctx.circuitBreaker.state).toBe("closed");
    ctx.circuitBreaker.destroy();
  });

  it("returns 404 for unknown token without tripping", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const res = mockRes();
    await handler(
      mockReq(`/admin/kill-token?t=${"a".repeat(48)}`),
      res.res,
    );
    expect(res.statusCode).toBe(404);
    expect(ctx.circuitBreaker.state).toBe("closed");
    ctx.circuitBreaker.destroy();
  });

  it("trips the circuit breaker on valid redemption", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const tok = issueKillToken("sess-1", "deleting emails");
    const res = mockRes();
    await handler(mockReq(`/admin/kill-token?t=${tok}`), res.res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("stopped");
    expect(ctx.circuitBreaker.state).toBe("open");
    ctx.circuitBreaker.destroy();
  });

  it("second redemption of the same token returns 404", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const tok = issueKillToken("sess-1", "r");
    await handler(mockReq(`/admin/kill-token?t=${tok}`), mockRes().res);
    // Breaker is already open — reset so we can verify the *redemption*
    // side of the second call independently.
    ctx.circuitBreaker.reset();
    const res = mockRes();
    await handler(mockReq(`/admin/kill-token?t=${tok}`), res.res);
    expect(res.statusCode).toBe(404);
    expect(ctx.circuitBreaker.state).toBe("closed");
    ctx.circuitBreaker.destroy();
  });

  it("HTML response has no-index meta and does not echo the token", async () => {
    const ctx = makeCtx();
    const handler = handleKillToken(ctx);
    const tok = issueKillToken("sess-1", "r");
    const res = mockRes();
    await handler(mockReq(`/admin/kill-token?t=${tok}`), res.res);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("noindex");
    expect(res.body).not.toContain(tok);
    ctx.circuitBreaker.destroy();
  });

  it("records a privileged audit entry on successful kill-token redemption", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ auditLog });
    const handler = handleKillToken(ctx);
    const tok = issueKillToken("sess-1", "deleting emails");
    await handler(mockReq(`/admin/kill-token?t=${tok}`), mockRes().res);

    const entries = auditLog.getEntries();
    const killEntry = entries.find((e) => e.toolId === "__kill_token");
    expect(killEntry).toBeDefined();
    expect(killEntry!.effectClass).toBe("privileged");
    expect(killEntry!.resultStatus).toBe("success");
    expect(killEntry!.callerRole).toBe("kill-token");
    expect(killEntry!.sessionKey).toBe("sess-1");
    expect(killEntry!.parameters.outcome).toBe("redeemed");
    // Token contents must NOT appear in the audit entry.
    expect(JSON.stringify(killEntry!.parameters)).not.toContain(tok);
    ctx.circuitBreaker.destroy();
  });

  it("records a denied audit entry on failed kill-token redemption", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ auditLog });
    const handler = handleKillToken(ctx);
    await handler(
      mockReq(`/admin/kill-token?t=${"a".repeat(48)}`),
      mockRes().res,
    );
    const entries = auditLog.getEntries();
    const killEntry = entries.find((e) => e.toolId === "__kill_token");
    expect(killEntry).toBeDefined();
    expect(killEntry!.resultStatus).toBe("denied");
    expect(killEntry!.parameters.outcome).toBe("redemption_failed");
    expect(killEntry!.callerRole).toBe("anonymous");
    ctx.circuitBreaker.destroy();
  });
});

describe("handleCircuitBreaker audit chain", () => {
  it("records a privileged trip entry on successful POST trip", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ adminToken: "secret-32-chars-long-enough-yes-it-is", auditLog });
    const handler = handleCircuitBreaker(ctx);
    const res = mockRes();
    await handler(
      mockReqWithAuth(
        "/admin/circuit-breaker",
        "POST",
        "secret-32-chars-long-enough-yes-it-is",
        '{"action":"trip"}',
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(ctx.circuitBreaker.state).toBe("open");

    const entries = auditLog.getEntries();
    const trip = entries.find(
      (e) => e.toolId === "__circuit_breaker" && e.parameters.action === "trip",
    );
    expect(trip).toBeDefined();
    expect(trip!.effectClass).toBe("privileged");
    expect(trip!.resultStatus).toBe("success");
    expect(trip!.callerRole).toBe("admin");
    expect(trip!.sessionKey).toBe("__admin");
    ctx.circuitBreaker.destroy();
  });

  it("records a privileged reset entry on successful POST reset", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ adminToken: "secret-32-chars-long-enough-yes-it-is", auditLog });
    ctx.circuitBreaker.trip("test setup");
    const handler = handleCircuitBreaker(ctx);
    const res = mockRes();
    await handler(
      mockReqWithAuth(
        "/admin/circuit-breaker",
        "POST",
        "secret-32-chars-long-enough-yes-it-is",
        '{"action":"reset"}',
      ),
      res.res,
    );
    expect(res.statusCode).toBe(200);
    expect(ctx.circuitBreaker.state).toBe("closed");

    const entries = auditLog.getEntries();
    const reset = entries.find(
      (e) => e.toolId === "__circuit_breaker" && e.parameters.action === "reset",
    );
    expect(reset).toBeDefined();
    expect(reset!.resultStatus).toBe("success");
    ctx.circuitBreaker.destroy();
  });

  it("records a denied entry when auth fails on a POST trip attempt", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ adminToken: "real-token-32-chars-long-enough-x", auditLog });
    const handler = handleCircuitBreaker(ctx);
    const res = mockRes();
    await handler(
      mockReqWithAuth(
        "/admin/circuit-breaker",
        "POST",
        "wrong-token-but-also-32-chars-long",
        '{"action":"trip"}',
      ),
      res.res,
    );
    expect(res.statusCode).toBe(401);
    expect(ctx.circuitBreaker.state).toBe("closed");

    const entries = auditLog.getEntries();
    const denied = entries.find((e) => e.toolId === "__circuit_breaker");
    expect(denied).toBeDefined();
    expect(denied!.resultStatus).toBe("denied");
    expect(denied!.callerRole).toBe("anonymous");
    expect(denied!.parameters.outcome).toBe("auth_rejected");
    ctx.circuitBreaker.destroy();
  });

  it("does NOT record an audit entry for unauthenticated GET probes (read-only, not state-changing)", async () => {
    const auditLog = createAuditLog();
    const ctx = makeCtx({ adminToken: "real-token-32-chars-long-enough-x", auditLog });
    const handler = handleCircuitBreaker(ctx);
    const res = mockRes();
    await handler(mockReq("/admin/circuit-breaker"), res.res);
    expect(res.statusCode).toBe(401);
    expect(auditLog.getEntries()).toHaveLength(0);
    ctx.circuitBreaker.destroy();
  });
});
