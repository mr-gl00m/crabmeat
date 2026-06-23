/**
 * ConnectorSink — the abstraction that decouples the inference pipeline
 * from the transport layer.
 *
 * Instead of inference.ts knowing about WebSockets, it writes to a
 * ConnectorSink. Each transport (WebSocket, Discord, Email, CLI,
 * BufferSink for scheduler) implements this interface.
 */

export interface ConnectorSink {
  /** Stream a token fragment to the client. */
  sendToken(token: string, sessionKey: string): void;

  /** Signal that the response is complete. */
  sendDone(sessionKey: string, messageId: string): void;

  /** Send an error to the client. */
  sendError(code: string, message: string): void;

  /** Notify tool execution status (running / success / error). */
  sendToolStatus(
    sessionKey: string,
    toolName: string,
    callId: string,
    status: "running" | "success" | "error",
    meta?: Record<string, unknown>,
  ): void;

  /** Push an audit log entry. */
  sendAuditEntry(entry: AuditEntryData): void;

  /** Whether the sink is still accepting data (e.g. WS is open). */
  isOpen(): boolean;

  /**
   * Request permission escalation from the user.
   * Optional — sinks that don't support interactive escalation
   * should omit this (escalation will be denied automatically).
   *
   * Returns true if the user grants the request, false if denied.
   */
  requestPermission?(
    sessionKey: string,
    toolName: string,
    effectNeeded: string,
    reason: string,
  ): Promise<boolean>;

  /**
   * Emit a running cost update after a turn completes. Optional —
   * sinks that don't surface cost (BufferSink, CLI) can omit this.
   * `priced=false` means the model had no pricing entry and the
   * client should label the number "unavailable" rather than "$0".
   */
  sendCostUpdate?(
    sessionKey: string,
    turnUsd: number,
    sessionUsd: number,
    priced: boolean,
  ): void;
}

/** Audit entry data passed to sendAuditEntry. */
export interface AuditEntryData {
  seq: number;
  sessionKey: string;
  toolId: string;
  effectClass: string;
  resultStatus: "success" | "error" | "denied";
  durationMs: number;
  hash: string;
}

/**
 * Trust level assigned to a connector. Determines which tool effect
 * classes are allowed for messages arriving through this connector.
 */
export type ConnectorTrustLevel = "admin" | "trusted" | "standard" | "untrusted";

/**
 * Base interface for external connectors (Discord, Email, CLI, etc.).
 * Each connector maps external IDs to channelId/peerId for routing,
 * declares its trust level, and manages its own lifecycle.
 */
export interface Connector {
  /** Unique identifier for this connector instance. */
  readonly id: string;

  /** Human-readable name (e.g. "discord", "email", "cli"). */
  readonly name: string;

  /** Trust level for messages arriving through this connector. */
  readonly trustLevel: ConnectorTrustLevel;

  /** Start listening / polling. */
  start(): Promise<void>;

  /** Graceful shutdown. */
  stop(): Promise<void>;
}
