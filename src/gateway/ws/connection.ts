import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { Config } from "../../config/types.js";
import type { InferencePipeline } from "../../agents/inference.js";
import type { SessionStore } from "../../sessions/store.js";
import type { RateLimiter } from "../../security/rate-limiter.js";
import type { CircuitBreaker } from "../../security/circuit-breaker.js";
import { logger } from "../../infra/logger.js";
import { createAuthLimiter, createConnectionLimiter } from "../auth/rate-limit.js";
import { performHandshake, type ServerInfo } from "./handshake.js";
import { attachMessageHandler } from "./handler.js";

function getClientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

// ── Heartbeat ────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30_000; // Ping every 30s; pong must arrive before next ping

/**
 * Attach a ping/pong heartbeat to keep the connection alive and detect
 * dead peers. The server pings every 30s; if no pong arrives within 10s,
 * the connection is terminated.
 */
function attachHeartbeat(ws: WebSocket): () => void {
  let pongReceived = true;

  const interval = setInterval(() => {
    if (!pongReceived) {
      logger.info("Closing WebSocket — missed heartbeat pong");
      ws.terminate();
      return;
    }
    pongReceived = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  const onPong = () => { pongReceived = true; };
  ws.on("pong", onPong);

  // Return cleanup function
  return () => {
    clearInterval(interval);
    ws.removeListener("pong", onPong);
  };
}

export interface ConnectionHandler {
  handle(ws: WebSocket, req: IncomingMessage, config: Config): Promise<void>;
  destroy(): void;
}

export function createConnectionHandler(
  pipeline: InferencePipeline,
  store: SessionStore,
  circuitBreaker?: CircuitBreaker,
): ConnectionHandler {
  const connLimiter: RateLimiter = createConnectionLimiter();
  const authLimiter: RateLimiter = createAuthLimiter();

  return {
    async handle(ws, req, config) {
      const ip = getClientIp(req);
      const origin = req.headers.origin;

      if (!connLimiter.check(ip)) {
        logger.warn({ ip }, "Connection rate limited");
        ws.close(4429, "Too many connections");
        return;
      }

      logger.info({ ip, origin }, "New WebSocket connection");

      // Check if this IP is already locked out from auth failures
      if (authLimiter.remaining(ip) === 0) {
        logger.warn({ ip }, "Auth rate limited");
        ws.close(4429, "Too many auth attempts");
        return;
      }

      const agent = config.agents[0];
      const provider = config.providers[0];
      const serverInfo: ServerInfo = {
        agent: agent?.name ?? agent?.id ?? "default",
        provider: provider?.id ?? "none",
        model: provider?.model ?? "unknown",
        arbiter: "enabled",
        auth: config.gateway.auth.mode,
        tools: (config.tools?.length ?? 0) + (agent?.tools.length ?? 0),
        sessions: config.session?.backend ?? "memory",
      };

      const result = await performHandshake(ws, config.gateway, origin, undefined, serverInfo);

      if (!result.success) {
        // Record the failed auth attempt (consumes a slot)
        authLimiter.check(ip);
        return;
      }

      // Start heartbeat after successful auth
      const stopHeartbeat = attachHeartbeat(ws);
      ws.on("close", stopHeartbeat);

      attachMessageHandler(ws, config, pipeline, store, circuitBreaker);
    },

    destroy() {
      connLimiter.destroy();
      authLimiter.destroy();
    },
  };
}
