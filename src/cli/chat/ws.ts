/**
 * WebSocket lifecycle hook for the chat client.
 *
 * Wraps connection, auth, request/response correlation, event
 * dispatch, and reconnection backoff. Connection state lives here
 * (separate from the chat reducer) so reconnection churn doesn't
 * trigger full message-list re-renders.
 *
 * Mirrors the protocol the readline client used — no server changes.
 * Same chat.send / chat.queue / chat.history / user.answer methods,
 * same chat.token / chat.done / tool.execute / user.question /
 * message.outbound / input.queued / command.recognized / audit.entry
 * events.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ChatAction, PendingQuestion, OutboundMirrorData } from "./reducer.js";

export type ConnectionState =
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "auth_failed";

export interface ServerInfo {
  agent: string;
  provider: string;
  model: string;
  arbiter: string;
  auth: string;
  tools: number;
  sessions: string;
}

export interface WsHookOptions {
  url: string;
  token: string;
  /** Channel id to bind the session to, optional. */
  channel?: string;
  /** Reducer dispatch from the chat state. */
  dispatch: (action: ChatAction) => void;
  /** Fires once on first successful connect with server-side info for the welcome screen. */
  onWelcome?: (info: ServerInfo | undefined) => void;
}

export interface WsHookHandle {
  /** Current high-level connection state. */
  connection: ConnectionState;
  /** How many reconnect attempts have fired. Reset on successful connect. */
  reconnectAttempts: number;
  /**
   * Send a request and await the response. Throws on transport
   * failure; returns the {status, data, error} envelope from the
   * gateway on success.
   */
  send: (method: string, params: Record<string, unknown>) => Promise<WsResponse>;
  /** Force a clean disconnect. No reconnection will be attempted. */
  close: () => void;
}

interface WsResponse {
  status: "ok" | "error";
  data?: unknown;
  error?: { code: string; message: string };
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;
const REQUEST_TIMEOUT_MS = 120_000;

function reconnectDelay(attempt: number): number {
  const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return backoff + Math.floor(Math.random() * 500);
}

interface PendingRequest {
  resolve: (res: WsResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function useWebSocket(opts: WsHookOptions): WsHookHandle {
  const { url, token, channel, dispatch, onWelcome } = opts;

  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest dispatch / onWelcome refs so the connect closure doesn't
  // capture a stale render's version. The connect function is created
  // once per session lifecycle (not once per render).
  const dispatchRef = useRef(dispatch);
  const onWelcomeRef = useRef(onWelcome);
  dispatchRef.current = dispatch;
  onWelcomeRef.current = onWelcome;
  // Channel can change between renders if a parent re-renders with a
  // different routing target, so capture the latest value the same way.
  const channelRef = useRef(channel);
  channelRef.current = channel;

  const sendRaw = useCallback(
    (frame: Record<string, unknown>): void => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(frame));
    },
    [],
  );

  const send = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<WsResponse> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          status: "error",
          error: { code: "DISCONNECTED", message: "Not connected" },
        };
      }
      const id = randomUUID();
      const frame = { id, type: "req", method, params };
      return await new Promise<WsResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error(`Request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify(frame));
      });
    },
    [],
  );

  const close = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    const connect = (): void => {
      if (cancelled) return;
      const isReconnect = attempt > 0;
      setConnection(isReconnect ? "reconnecting" : "connecting");

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.on("open", () => {
        if (cancelled) {
          ws.close();
          return;
        }
        setConnection("authenticating");
        const id = randomUUID();
        const frame = {
          id,
          type: "req",
          method: "connect",
          params: { protocolVersion: 1, token },
        };
        // Track auth as a pending request so the response handler
        // resolves it through the same path as everything else.
        const timer = setTimeout(() => {
          pendingRef.current.delete(id);
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(id, {
          resolve: (res) => {
            if (cancelled) return;
            if (res.status === "ok") {
              setConnection("connected");
              setReconnectAttempts(0);
              attempt = 0;
              const info = (res.data as { serverInfo?: ServerInfo } | undefined)
                ?.serverInfo;
              if (!isReconnect) onWelcomeRef.current?.(info);
              else
                dispatchRef.current({
                  type: "SYSTEM",
                  content: "Reconnected",
                  level: "success",
                });
            } else {
              setConnection("auth_failed");
              dispatchRef.current({
                type: "ERROR",
                code: res.error?.code ?? "AUTH_FAILED",
                message: res.error?.message ?? "Authentication failed",
              });
              intentionalCloseRef.current = true;
            }
          },
          reject: () => {},
          timer,
        });
        ws.send(JSON.stringify(frame));
      });

      ws.on("message", (raw) => {
        if (cancelled) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        handleFrame(msg);
      });

      ws.on("close", (code, reason) => {
        // Clear any pending requests — they won't resolve.
        for (const { timer, resolve } of pendingRef.current.values()) {
          clearTimeout(timer);
          resolve({
            status: "error",
            error: { code: "DISCONNECTED", message: "Connection lost" },
          });
        }
        pendingRef.current.clear();
        wsRef.current = null;

        if (cancelled || intentionalCloseRef.current) {
          setConnection("disconnected");
          return;
        }

        const reasonStr = reason ? reason.toString() : "";
        dispatchRef.current({
          type: "SYSTEM",
          content: `Connection lost (${code}${reasonStr ? ` ${reasonStr}` : ""})`,
          level: "warn",
        });

        attempt += 1;
        setReconnectAttempts(attempt);
        if (attempt > RECONNECT_MAX_ATTEMPTS) {
          setConnection("disconnected");
          dispatchRef.current({
            type: "SYSTEM",
            content: `Gave up after ${RECONNECT_MAX_ATTEMPTS} reconnection attempts`,
            level: "error",
          });
          return;
        }

        const delay = reconnectDelay(attempt - 1);
        dispatchRef.current({
          type: "SYSTEM",
          content: `Reconnecting in ${(delay / 1000).toFixed(1)}s...`,
          level: "info",
        });
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.on("error", () => {
        // ws will fire "close" right after; let that drive reconnect logic.
      });

      ws.on("ping", () => {
        ws.pong();
      });
    };

    const handleFrame = (msg: Record<string, unknown>): void => {
      if (msg.type === "res" && typeof msg.replyTo === "string") {
        const pending = pendingRef.current.get(msg.replyTo);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRef.current.delete(msg.replyTo);
          pending.resolve(msg as unknown as WsResponse);
        }
        return;
      }

      if (msg.type === "event") {
        const event = msg.event as string;
        const data = (msg.data ?? {}) as Record<string, unknown>;

        switch (event) {
          case "chat.token":
            dispatchRef.current({ type: "TOKEN", text: String(data.token ?? "") });
            return;
          case "chat.done":
            // Reducer recomputes durationMs / tokens / tool count from
            // its own state in the TURN_DONE branch — keeps this hook
            // ignorant of message-level counting.
            dispatchRef.current({ type: "TURN_DONE" });
            return;
          case "tool.execute":
            dispatchRef.current({
              type: "TOOL_EVENT",
              toolName: String(data.toolName ?? "?"),
              status: String(data.status ?? "?"),
            });
            return;
          case "input.queued":
            dispatchRef.current({
              type: "INPUT_QUEUED_ACK",
              preview: String(data.preview ?? ""),
              position: Number(data.position ?? 0),
              kind: data.kind === "control" ? "control" : "queue",
            });
            return;
          case "user.question":
            dispatchRef.current({
              type: "ASK_USER",
              question: data as unknown as PendingQuestion,
            });
            return;
          case "message.outbound":
            dispatchRef.current({
              type: "OUTBOUND_MIRROR",
              data: data as unknown as OutboundMirrorData,
            });
            return;
          case "command.recognized":
            return;
          case "audit.entry":
            return;
        }
        return;
      }

      if (msg.type === "error") {
        const err = (msg.error ?? {}) as { code?: string; message?: string };
        dispatchRef.current({
          type: "ERROR",
          code: err.code ?? "UNKNOWN",
          message: err.message ?? "Unknown error",
        });
        return;
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      for (const { timer } of pendingRef.current.values()) {
        clearTimeout(timer);
      }
      pendingRef.current.clear();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      wsRef.current = null;
    };
    // url and token are session-stable; intentionally not retriggering
    // reconnect on dispatch/onWelcome ref changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token]);

  // channel is read off the ref so it doesn't trigger reconnect; reads
  // happen inside send() callers which can pass it in params.
  void channelRef;
  void sendRaw;

  return {
    connection,
    reconnectAttempts,
    send,
    close,
  };
}
