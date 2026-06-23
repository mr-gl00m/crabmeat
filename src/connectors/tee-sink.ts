/**
 * TeeSink — fans out every ConnectorSink call to multiple underlying sinks.
 *
 * Primary use case: an inbound email turn writes its reply into a
 * BufferSink (so the connector can produce a reply body), but anyone
 * watching via the CLI/WebSocket should also see the live token stream
 * for that turn. Without a tee, the email path is invisible to observers.
 *
 * Design notes:
 * - Send methods fan out unconditionally — a failing observer must not
 *   take down the primary delivery path. Errors are swallowed at the
 *   per-sink boundary.
 * - `isOpen()` returns true if ANY underlying sink is open. The primary
 *   (buffer) sink is always open during a turn, so this is essentially
 *   "is the turn still active."
 * - `requestPermission` is intentionally NOT delegated: only the primary
 *   sink (first in the list) decides escalation. Observers can't grant
 *   permissions because they aren't authoritative — a CLI watcher of an
 *   email turn shouldn't be able to approve effects on behalf of the
 *   email sender.
 */

import type { ConnectorSink, AuditEntryData } from "./types.js";

export function createTeeSink(sinks: ConnectorSink[]): ConnectorSink {
  if (sinks.length === 0) {
    throw new Error("createTeeSink requires at least one underlying sink");
  }
  const primary = sinks[0]!;

  function safeFanOut(fn: (s: ConnectorSink) => void): void {
    for (const s of sinks) {
      try {
        fn(s);
      } catch {
        // Swallow — one observer failing must not affect others or the primary.
      }
    }
  }

  return {
    sendToken(token: string, sessionKey: string): void {
      safeFanOut((s) => s.sendToken(token, sessionKey));
    },

    sendDone(sessionKey: string, messageId: string): void {
      safeFanOut((s) => s.sendDone(sessionKey, messageId));
    },

    sendError(code: string, message: string): void {
      safeFanOut((s) => s.sendError(code, message));
    },

    sendToolStatus(sessionKey, toolName, callId, status, meta?): void {
      safeFanOut((s) => s.sendToolStatus(sessionKey, toolName, callId, status, meta));
    },

    sendAuditEntry(entry: AuditEntryData): void {
      safeFanOut((s) => s.sendAuditEntry(entry));
    },

    isOpen(): boolean {
      return sinks.some((s) => {
        try {
          return s.isOpen();
        } catch {
          return false;
        }
      });
    },

    async requestPermission(sessionKey, toolName, effectNeeded, reason): Promise<boolean> {
      if (!primary.requestPermission) return false;
      return primary.requestPermission(sessionKey, toolName, effectNeeded, reason);
    },
  };
}
