/**
 * GET /greenlight HTTP route (Phase 4.19 B1).
 *
 * Returns the composite go/no-go verdict from evaluateGreenlight as
 * JSON. Auth-gated when admin auth is configured (operational state
 * about providers + circuit breaker is more useful to attackers than
 * the bare /health surface). When admin auth is not configured the
 * endpoint is open — same posture as /health for dev-mode operators.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  evaluateGreenlight,
  type GreenlightVerdict,
} from "../greenlight.js";
import type { Config } from "../../config/types.js";
import type { CircuitBreaker } from "../../security/circuit-breaker.js";
import type { Provider } from "../../agents/providers/types.js";
import { secretEqual } from "../../security/secret-equal.js";

export interface GreenlightContext {
  /** Admin token for auth gating; null disables auth on this endpoint. */
  adminToken: string | null;
  config: Config;
  circuitBreaker: CircuitBreaker;
  providers?: { getProvider(id: string): Provider | undefined };
}

function rejectNonRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  res.writeHead(405, { Allow: "GET, HEAD" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
  return true;
}

function checkAuth(
  req: IncomingMessage,
  adminToken: string | null,
): boolean {
  if (adminToken === null || adminToken.length === 0) return true;
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  return secretEqual(m[1]!.trim(), adminToken);
}

export function handleGreenlight(ctx: GreenlightContext) {
  return async function (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (rejectNonRead(req, res)) return;
    if (!checkAuth(req, ctx.adminToken)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let verdict: GreenlightVerdict;
    try {
      verdict = await evaluateGreenlight({
        config: ctx.config,
        circuitBreaker: ctx.circuitBreaker,
        getProvider: ctx.providers
          ? (id: string) => ctx.providers!.getProvider(id)
          : undefined,
      });
    } catch (err) {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: "greenlight evaluation failed",
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    // 503 when the gateway is not ready — that's the conventional
    // load-balancer / health-check signal for "stop sending traffic."
    // 200 when ready. Body is the same JSON shape either way so the
    // caller can render the per-component breakdown.
    res.writeHead(verdict.ready ? 200 : 503, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(verdict));
  };
}
