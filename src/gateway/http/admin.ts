import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { CircuitBreaker } from "../../security/circuit-breaker.js";
import type { AuditLog } from "../../security/audit.js";
import { secretEqual } from "../../security/secret-equal.js";
import { verifyAndRedeem as verifyKillToken } from "../../security/kill-tokens.js";
import { logger } from "../../infra/logger.js";

/**
 * Admin endpoints for operational control:
 *
 *   POST /admin/kill            — Graceful shutdown (closes all connections, exits)
 *   POST /admin/circuit-breaker — Toggle circuit breaker { "action": "trip" | "reset" }
 *   GET  /admin/circuit-breaker — Current circuit breaker state
 *   GET  /admin/kill-token      — Redeem a single-use kill token (query: t=TOKEN)
 *
 * The POST endpoints require `Authorization: Bearer <adminToken>` header.
 *
 * The GET /admin/kill-token endpoint is intentionally unauthenticated —
 * the token IS the credential. It's embedded in every outbound message
 * the agent sends to external channels so the user always has an
 * out-of-band emergency stop no matter which device they're holding.
 * Redemption is single-use and trips the circuit breaker.
 */
export interface AdminContext {
  adminToken: string;
  circuitBreaker: CircuitBreaker;
  /**
   * Audit log for recording privileged-op entries. Every admin endpoint
   * that mutates global state (circuit-breaker trip/reset, kill,
   * kill-token redemption) emits an entry into the same tamper-evident
   * chain as tool calls — the audit trail's value depends on it being
   * the single source of truth, not a partial log.
   */
  auditLog: AuditLog;
  shutdownFn: () => Promise<void>;
}

/**
 * Pseudo-tool ids used for privileged operations that are not real
 * agent tools but should still appear in the audit chain. The double-
 * underscore prefix mirrors the existing convention used by Layer 2
 * routing (`__layer2_routing`) and owner-only tool gating
 * (`__circuit_breaker` here is its first user). Effect class is
 * "privileged" — distinct from the four agent-tool effect classes
 * (read / write / exec / network) so a downstream filter can isolate
 * privileged-op events from tool calls.
 */
const PSEUDO_TOOL_CIRCUIT_BREAKER = "__circuit_breaker";
const PSEUDO_TOOL_ADMIN_KILL = "__admin_kill";
const PSEUDO_TOOL_KILL_TOKEN = "__kill_token";

/**
 * Record a privileged-op audit entry. Centralizes the boilerplate so
 * every admin handler that mutates global state hits the chain with a
 * consistent shape. Failures here are logged but do NOT prevent the
 * underlying operation from completing — the operator can inspect logs
 * separately, but a circuit-breaker trip should never fail because the
 * audit log was unreachable.
 */
function recordPrivilegedOp(
  auditLog: AuditLog,
  toolId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  resultStatus: "success" | "error" | "denied",
  durationMs: number,
  callerRole: "admin" | "kill-token" | "anonymous" = "admin",
  sessionKey: string = "__admin",
): void {
  try {
    auditLog.record({
      timestamp: new Date().toISOString(),
      sessionKey,
      toolId,
      toolName,
      effectClass: "privileged",
      callId: randomUUID(),
      parameters,
      resultStatus,
      durationMs,
      callerRole,
    });
  } catch (err) {
    logger.error(
      { err, toolId, parameters },
      "Privileged op audit-record failed — operation completed but audit chain has a gap",
    );
  }
}

function authenticate(req: IncomingMessage, adminToken: string): boolean {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return secretEqual(token, adminToken);
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401);
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function rejectMethod(res: ServerResponse): void {
  res.writeHead(405);
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BODY = 4096;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function handleAdminKill(ctx: AdminContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const start = Date.now();

    if (req.method !== "POST") {
      rejectMethod(res);
      return;
    }

    if (!authenticate(req, ctx.adminToken)) {
      // Audit the failed-auth attempt — privileged-endpoint probes
      // belong in the chain even (especially) when they bounce.
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_ADMIN_KILL,
        "admin_kill",
        { outcome: "auth_rejected" },
        "denied",
        Date.now() - start,
        "anonymous",
      );
      rejectUnauthorized(res);
      return;
    }

    logger.warn("Admin kill endpoint triggered — initiating shutdown");
    recordPrivilegedOp(
      ctx.auditLog,
      PSEUDO_TOOL_ADMIN_KILL,
      "admin_kill",
      { outcome: "shutdown_initiated" },
      "success",
      Date.now() - start,
    );

    res.writeHead(200);
    res.end(JSON.stringify({ status: "shutting_down" }));

    // Small delay to allow the response to flush. Also flush the audit
    // chain to disk before exiting so the kill entry is durable — the
    // process is about to terminate, the in-memory entry would
    // otherwise be lost.
    setTimeout(async () => {
      try {
        await ctx.auditLog.flush();
      } catch (err) {
        logger.error({ err }, "Audit flush before kill failed — kill entry may not be persisted");
      }
      try {
        await ctx.shutdownFn();
      } catch (err) {
        logger.error({ err }, "Error during admin kill shutdown");
      }
      process.exit(0);
    }, 100);
  };
}

export function handleCircuitBreaker(ctx: AdminContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const start = Date.now();

    if (req.method !== "GET" && req.method !== "POST") {
      rejectMethod(res);
      return;
    }

    if (!authenticate(req, ctx.adminToken)) {
      // Only audit POSTs (state-changing intent). GET probes get
      // dropped on the floor — they're noise.
      if (req.method === "POST") {
        recordPrivilegedOp(
          ctx.auditLog,
          PSEUDO_TOOL_CIRCUIT_BREAKER,
          "circuit_breaker",
          { outcome: "auth_rejected" },
          "denied",
          Date.now() - start,
          "anonymous",
        );
      }
      rejectUnauthorized(res);
      return;
    }

    // GET — return current state. No audit entry; reading state is not
    // a privileged mutation.
    if (req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ state: ctx.circuitBreaker.state }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_CIRCUIT_BREAKER,
        "circuit_breaker",
        { outcome: "invalid_body" },
        "error",
        Date.now() - start,
      );
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid body" }));
      return;
    }

    let parsed: { action?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_CIRCUIT_BREAKER,
        "circuit_breaker",
        { outcome: "invalid_json" },
        "error",
        Date.now() - start,
      );
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (parsed.action === "trip") {
      ctx.circuitBreaker.trip("Admin endpoint");
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_CIRCUIT_BREAKER,
        "circuit_breaker",
        { action: "trip", reason: "Admin endpoint", state: ctx.circuitBreaker.state },
        "success",
        Date.now() - start,
      );
      res.writeHead(200);
      res.end(JSON.stringify({ state: ctx.circuitBreaker.state }));
    } else if (parsed.action === "reset") {
      ctx.circuitBreaker.reset();
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_CIRCUIT_BREAKER,
        "circuit_breaker",
        { action: "reset", state: ctx.circuitBreaker.state },
        "success",
        Date.now() - start,
      );
      res.writeHead(200);
      res.end(JSON.stringify({ state: ctx.circuitBreaker.state }));
    } else {
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_CIRCUIT_BREAKER,
        "circuit_breaker",
        { outcome: "invalid_action", action: String(parsed.action ?? "") },
        "error",
        Date.now() - start,
      );
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid action — use 'trip' or 'reset'" }));
    }
  };
}

/**
 * Render the static kill-confirmation page (used for both the success
 * and failure responses). Kept as HTML escape-safe plain text so no
 * user-controlled data ever lands in the output.
 */
function renderKillPage(status: "ok" | "invalid" | "error", detail: string): string {
  const title =
    status === "ok"
      ? "Agent stopped."
      : status === "invalid"
        ? "Kill link invalid or expired."
        : "Kill link failed.";
  const color = status === "ok" ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CrabMeat — ${title}</title>
<style>
 body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; margin: 0; padding: 2rem; }
 .card { max-width: 32rem; margin: 4rem auto; background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 2rem; }
 h1 { color: ${color}; margin-top: 0; font-size: 1.4rem; }
 p { line-height: 1.5; color: #a3a3a3; }
 code { background: #0a0a0a; padding: 0.15rem 0.4rem; border-radius: 4px; color: #e5e5e5; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/**
 * GET /admin/kill-token?t=TOKEN
 *
 * Unauthenticated (the token is the credential). On success: redeems
 * the token, trips the circuit breaker, logs the event, returns an
 * HTML confirmation page. On failure (unknown/expired/malformed token)
 * returns a 404 with a generic error page — no distinguishing detail,
 * so a scraper can't probe the token space.
 */
export function handleKillToken(ctx: AdminContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const start = Date.now();

    if (req.method !== "GET") {
      rejectMethod(res);
      return;
    }

    let token: string | null = null;
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      token = url.searchParams.get("t");
    } catch {
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_KILL_TOKEN,
        "kill_token",
        { outcome: "malformed_url" },
        "error",
        Date.now() - start,
        "anonymous",
      );
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderKillPage("error", "Malformed request."));
      return;
    }

    const redeemed = token === null ? null : verifyKillToken(token);
    if (!redeemed) {
      logger.warn(
        { ip: req.socket?.remoteAddress ?? "unknown" },
        "Kill token redemption failed",
      );
      // Audit the failed redemption — token-space probes belong in the
      // chain. Token contents are NOT recorded — only the outcome and
      // remote address (lower-cased / truncated).
      recordPrivilegedOp(
        ctx.auditLog,
        PSEUDO_TOOL_KILL_TOKEN,
        "kill_token",
        {
          outcome: "redemption_failed",
          remote: (req.socket?.remoteAddress ?? "unknown").slice(0, 64),
        },
        "denied",
        Date.now() - start,
        "anonymous",
      );
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderKillPage(
          "invalid",
          "This link is not valid, already used, or has expired. If the agent is still running, send a stop command directly from the console.",
        ),
      );
      return;
    }

    ctx.circuitBreaker.trip(
      `Kill token redeemed for session ${redeemed.sessionKey}` +
        (redeemed.reason ? ` — ${redeemed.reason}` : ""),
    );
    logger.warn(
      { sessionKey: redeemed.sessionKey, reason: redeemed.reason },
      "Kill token redeemed — circuit breaker tripped",
    );
    // Successful redemption — sessionKey ties this to the originating
    // session so a forensic audit can reconstruct the kill source.
    recordPrivilegedOp(
      ctx.auditLog,
      PSEUDO_TOOL_KILL_TOKEN,
      "kill_token",
      {
        outcome: "redeemed",
        reason: redeemed.reason ?? "(none)",
        breakerState: ctx.circuitBreaker.state,
      },
      "success",
      Date.now() - start,
      "kill-token",
      redeemed.sessionKey,
    );

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderKillPage(
        "ok",
        "The agent has been stopped. Transcripts and history are preserved. Use the console to resume when you're ready.",
      ),
    );
  };
}
