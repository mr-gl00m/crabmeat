import type { WebSocket } from "ws";
import type { GatewayConfig } from "../../config/types.js";
import { logger } from "../../infra/logger.js";
import { authenticate } from "../auth/auth.js";
import { isOriginAllowed } from "../auth/origin.js";
import {
  connectFrameSchema,
  makeResponse,
  makeErrorEvent,
  PRE_AUTH_MAX_BYTES,
  PROTOCOL_VERSION,
  type ConnectFrame,
} from "./protocol.js";
import { checkByteSize, stripNullBytes } from "../../security/sanitize.js";

export interface ServerInfo {
  agent: string;
  provider: string;
  model: string;
  arbiter: string;
  auth: string;
  tools: number;
  sessions: string;
}

export interface HandshakeResult {
  success: boolean;
  connectFrame?: ConnectFrame;
  reason?: string;
}

/**
 * Wait for the client's connect frame, validate it, authenticate,
 * and check origin. Returns the validated connect frame on success.
 */
export function performHandshake(
  ws: WebSocket,
  config: GatewayConfig,
  origin: string | undefined,
  timeoutMs: number = 10_000,
  serverInfo?: ServerInfo,
): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      ws.send(JSON.stringify(makeErrorEvent("HANDSHAKE_TIMEOUT", "Handshake timed out")));
      ws.close(4000, "Handshake timeout");
      resolve({ success: false, reason: "Handshake timeout" });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
    }

    function onClose() {
      cleanup();
      resolve({ success: false, reason: "Connection closed during handshake" });
    }

    function onMessage(data: Buffer | ArrayBuffer | Buffer[]) {
      cleanup();

      const raw = Buffer.isBuffer(data) ? data.toString() : Buffer.from(data as ArrayBuffer).toString();

      // Size check (pre-auth)
      if (!checkByteSize(raw, PRE_AUTH_MAX_BYTES)) {
        ws.send(JSON.stringify(makeErrorEvent("FRAME_TOO_LARGE", "Pre-auth frame exceeds 64KB")));
        ws.close(4001, "Frame too large");
        resolve({ success: false, reason: "Frame too large" });
        return;
      }

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripNullBytes(raw));
      } catch {
        ws.send(JSON.stringify(makeErrorEvent("INVALID_JSON", "Invalid JSON")));
        ws.close(4002, "Invalid JSON");
        resolve({ success: false, reason: "Invalid JSON" });
        return;
      }

      // Validate connect frame
      const frameResult = connectFrameSchema.safeParse(parsed);
      if (!frameResult.success) {
        ws.send(
          JSON.stringify(
            makeErrorEvent("INVALID_CONNECT", "Expected connect frame"),
          ),
        );
        ws.close(4003, "Invalid connect frame");
        resolve({ success: false, reason: "Invalid connect frame" });
        return;
      }

      const frame = frameResult.data;

      // Protocol version check
      if (frame.params.protocolVersion !== PROTOCOL_VERSION) {
        ws.send(
          JSON.stringify(
            makeErrorEvent(
              "PROTOCOL_MISMATCH",
              `Expected protocol version ${PROTOCOL_VERSION}`,
            ),
          ),
        );
        ws.close(4004, "Protocol version mismatch");
        resolve({ success: false, reason: "Protocol version mismatch" });
        return;
      }

      // Origin check (browser clients)
      if (!isOriginAllowed(origin, config.origins)) {
        logger.warn({ origin }, "Origin rejected");
        ws.send(
          JSON.stringify(makeErrorEvent("ORIGIN_REJECTED", "Origin not allowed")),
        );
        ws.close(4005, "Origin not allowed");
        resolve({ success: false, reason: "Origin not allowed" });
        return;
      }

      // Authenticate
      const authResult = authenticate(config, {
        token: frame.params.token,
        password: frame.params.password,
      });

      if (!authResult.authenticated) {
        logger.warn({ reason: authResult.reason }, "Auth failed during handshake");
        ws.send(
          JSON.stringify(
            makeErrorEvent("AUTH_FAILED", authResult.reason ?? "Authentication failed"),
          ),
        );
        ws.close(4006, "Authentication failed");
        resolve({ success: false, reason: authResult.reason });
        return;
      }

      // Success — send connected response
      ws.send(
        JSON.stringify(
          makeResponse(frame.id, {
            protocolVersion: PROTOCOL_VERSION,
            status: "connected",
            ...(serverInfo ? { serverInfo } : {}),
          }),
        ),
      );

      logger.info("Client authenticated and connected");
      resolve({ success: true, connectFrame: frame });
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}
