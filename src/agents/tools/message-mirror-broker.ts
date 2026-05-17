/**
 * message-mirror-broker — the CLI mirror channel for outbound messages.
 *
 * When the agent uses message_send to talk to an external channel
 * (Discord, Telegram, etc.), we mirror a copy of every send into the
 * CLI session that owns the agent. This makes the CLI transcript the
 * single "everything-logged console" so the user can review, after the
 * fact, what the agent said on each external surface — even if they
 * weren't actively watching that channel at the time.
 *
 * The mirror is purely informational for the user UI; the transcript
 * append (which the model re-reads on subsequent turns) is a separate
 * concern handled inside message_send itself.
 *
 * Follows the same session→sender broker pattern as ask-user-broker:
 *   - gateway/ws/handler.ts registers a sink when a ws connection
 *     claims ownership of a session
 *   - the tool calls emitOutboundMirror(...) with the session key
 *   - on disconnect, the handler unregisters the sink
 */

import { logger } from "../../infra/logger.js";

export interface OutboundMirrorEvent {
  /** Session this mirror belongs to. */
  sessionKey: string;
  /** Stable message id for the mirror event. */
  messageId: string;
  /** Connector id (e.g. "discord", "telegram"). */
  channel: string;
  /** The content the agent intended to send. */
  content: string;
  /** Delivery outcome reported by the connector. */
  delivered: boolean;
  /** Error reason when delivered=false. */
  error?: string;
  /** Kill URL that was (or would have been) injected. */
  killUrl?: string;
  /** ISO timestamp of the send attempt. */
  timestamp: string;
}

export type OutboundMirrorSink = (event: OutboundMirrorEvent) => void;

const sinks: Map<string, OutboundMirrorSink> = new Map();

/**
 * Register the CLI-side sink for a session. Called from the ws handler
 * when a connection first claims ownership of a session.
 */
export function registerOutboundMirrorSink(
  sessionKey: string,
  sink: OutboundMirrorSink,
): void {
  sinks.set(sessionKey, sink);
}

/**
 * Unregister the sink for a session. Called on ws disconnect or on
 * LRU-eviction of an owned session.
 */
export function unregisterOutboundMirrorSink(sessionKey: string): void {
  sinks.delete(sessionKey);
}

/**
 * Push a mirror event to the CLI sink (if any). Missing sink is not
 * an error — it just means no ws client is currently watching this
 * session. The transcript append is still authoritative.
 */
export function emitOutboundMirror(event: OutboundMirrorEvent): void {
  const sink = sinks.get(event.sessionKey);
  if (!sink) return;
  try {
    sink(event);
  } catch (err) {
    logger.warn(
      { err, sessionKey: event.sessionKey, channel: event.channel },
      "Outbound mirror sink threw",
    );
  }
}

/** For tests — wipe all state. */
export function _resetOutboundMirror(): void {
  sinks.clear();
}

/** For tests — current number of registered sinks. */
export function _mirrorSinkCount(): number {
  return sinks.size;
}
