import type { Provider } from "../providers/types.js";
import type { ConnectorSink } from "../../connectors/types.js";
import type { Session } from "../../sessions/types.js";
import type { SessionStore } from "../../sessions/store.js";
import type { AuditLog } from "../../security/audit.js";
import type { Layer2Config } from "../../config/types.js";

// ── Results ──────────────────────────────────────────────

export interface Layer2Result {
  /** Whether Layer 2 handled the request (sent a response to the client). */
  handled: boolean;

  /** Whether the local model signaled it can't handle this (escalate to Layer 3). */
  escalated: boolean;

  /** Human-readable reason for the routing decision. */
  reason: string;

  /** The Layer 0 confidence score that led to Layer 2 routing. */
  layer0Confidence?: number;

  /** The response text from the local model, if any. */
  responseText?: string;
}

// ── Context ──────────────────────────────────────────────

export interface Layer2Context {
  config: Layer2Config;
  provider: Provider;
  sink: ConnectorSink;
  session: Session;
  sessionKey: string;
  store: SessionStore;
  auditLog: AuditLog;

  /** The Layer 0 classification confidence that triggered Layer 2 routing. */
  layer0Confidence: number;
}

// ── Escalation ───────────────────────────────────────────

export interface EscalationResult {
  shouldEscalate: boolean;
  matchedMarker?: string;
}
