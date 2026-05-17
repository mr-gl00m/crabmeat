/**
 * BufferSink — ConnectorSink that collects output in memory.
 *
 * Used by the scheduler, email connector, and anything that needs
 * to invoke the inference pipeline without a live transport.
 * Tokens accumulate into a string; tool/audit/error events are stored
 * in arrays for later inspection.
 *
 * Tool-call boundary semantics: when a tool call is dispatched
 * (`sendToolStatus(status="running")`), any text accumulated before
 * that point is intermediate reasoning emitted by the model in the
 * same message as the tool call — NOT a final answer to the user.
 * The buffer drops it so consumers (email reply, scheduler) only
 * receive the final post-all-tool-calls assistant text. Without this,
 * the model's stream-of-consciousness preamble leaks into the user's
 * inbox alongside the actual reply (2026-04-30 Trump-ballroom incident).
 */

import type { ConnectorSink, AuditEntryData } from "./types.js";

export interface BufferSinkResult {
  /** The full concatenated text response. */
  text: string;
  /** The messageId from the done event, if any. */
  messageId: string | null;
  /** All tool status events in order. */
  toolEvents: Array<{
    sessionKey: string;
    toolName: string;
    callId: string;
    status: "running" | "success" | "error";
    meta?: Record<string, unknown>;
  }>;
  /** All audit entries in order. */
  auditEntries: AuditEntryData[];
  /** All errors in order. */
  errors: Array<{ code: string; message: string }>;
}

export interface BufferSink extends ConnectorSink {
  /** Retrieve the accumulated result. */
  getResult(): BufferSinkResult;
  /** Reset the buffer for reuse. */
  reset(): void;
}

export function createBufferSink(): BufferSink {
  let text = "";
  let messageId: string | null = null;
  const toolEvents: BufferSinkResult["toolEvents"] = [];
  const auditEntries: AuditEntryData[] = [];
  const errors: BufferSinkResult["errors"] = [];

  return {
    sendToken(token) {
      text += token;
    },

    sendDone(_sessionKey, msgId) {
      messageId = msgId;
    },

    sendError(code, message) {
      errors.push({ code, message });
    },

    sendToolStatus(sessionKey, toolName, callId, status, meta?) {
      // A tool call is starting — any text accumulated up to this
      // point was reasoning the model emitted alongside its tool
      // call decision, not a final answer to the user. Discard it
      // so only the post-tool-call assistant text reaches the
      // bufferSink consumer.
      if (status === "running") {
        text = "";
      }
      toolEvents.push({ sessionKey, toolName, callId, status, ...(meta && { meta }) });
    },

    sendAuditEntry(entry) {
      auditEntries.push(entry);
    },

    isOpen() {
      return true; // Buffer is always accepting data
    },

    getResult() {
      return { text, messageId, toolEvents, auditEntries, errors };
    },

    reset() {
      text = "";
      messageId = null;
      toolEvents.length = 0;
      auditEntries.length = 0;
      errors.length = 0;
    },
  };
}
