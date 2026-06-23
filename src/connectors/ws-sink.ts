/**
 * WebSocketSink — ConnectorSink implementation that wraps a raw WebSocket.
 *
 * This is the drop-in replacement for the old `sendWs(ws, data)` pattern.
 * It serializes protocol events to JSON and sends them over the WebSocket.
 */

import type { WebSocket } from "ws";
import type { ConnectorSink } from "./types.js";
import {
  makeTokenEvent,
  makeDoneEvent,
  makeErrorEvent,
  makeToolExecuteEvent,
  makeAuditEntryEvent,
  makePermissionRequestEvent,
  makeChatCostEvent,
} from "../gateway/ws/protocol.js";

export function createWebSocketSink(ws: WebSocket): ConnectorSink {
  function send(data: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  return {
    sendToken(token, sessionKey) {
      send(makeTokenEvent(token, sessionKey));
    },

    sendDone(sessionKey, messageId) {
      send(makeDoneEvent(sessionKey, messageId));
    },

    sendError(code, message) {
      send(makeErrorEvent(code, message));
    },

    sendToolStatus(sessionKey, toolName, callId, status, meta?) {
      send(makeToolExecuteEvent(sessionKey, toolName, callId, status, meta));
    },

    sendAuditEntry(entry) {
      send(makeAuditEntryEvent(entry));
    },

    sendCostUpdate(sessionKey, turnUsd, sessionUsd, priced) {
      send(makeChatCostEvent(sessionKey, turnUsd, sessionUsd, priced));
    },

    isOpen() {
      return ws.readyState === ws.OPEN;
    },

    async requestPermission(sessionKey, toolName, effectNeeded, reason) {
      // Send a permission request event to the client.
      // For now, this is fire-and-forget — the client UI would need to
      // send back a permission.grant or permission.deny frame.
      // TODO: implement a request/response cycle with a timeout.
      // For the initial implementation, we send the event and auto-deny
      // (safe default). Full interactive escalation requires client support.
      send(makePermissionRequestEvent(sessionKey, toolName, effectNeeded, reason));
      return false; // Auto-deny until client-side escalation UI exists
    },
  };
}
