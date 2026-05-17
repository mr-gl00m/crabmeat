/**
 * Outbound connector registry — the thin layer that message_send uses
 * to deliver agent messages to external channels (Discord, Telegram,
 * Email, Signal, …).
 *
 * Design notes:
 *
 * - This is the *outbound* direction only. Inbound (messages arriving
 *   from external channels and routing into the agent) is handled by
 *   the full `Connector` interface in ./types.ts. Outbound is simpler
 *   because the message_send tool is the only caller, and the data
 *   flow is fire-and-forget with a delivery receipt.
 *
 * - Every external message carries a kill URL injected by the tool
 *   (not the connector) so the enforcement of "every outbound message
 *   is stoppable" lives in one place. Connectors MUST include the URL
 *   somewhere in the delivered payload — that's the invariant.
 *
 * - The CLI is not a connector here. It's a mirror that always
 *   shadows every external send via the message-mirror broker. The
 *   connectors in this registry are strictly *external* channels.
 *
 * Stage (a) ships the registry with zero connectors registered.
 * Stage (b) adds the Discord webhook connector.
 * Stage (c) adds the Telegram bot connector.
 */

import type { ConnectorTrustLevel } from "./types.js";

export interface OutboundDeliverOptions {
  /** Session the message is being sent on behalf of. */
  sessionKey: string;
  /** The message body the agent wants to deliver. */
  content: string;
  /**
   * Kill URL that MUST appear in the delivered payload. Connectors
   * are expected to append it to the content (or surface it in a
   * channel-native way, e.g. a Discord embed field). An empty string
   * means no URL was issued — only acceptable when the caller has
   * explicitly opted out of kill-link injection.
   */
  killUrl: string;
  /** Short human-readable reason, surfaced alongside the kill link. */
  reason: string;
}

export interface OutboundDeliverResult {
  /** Whether the connector accepted the message for delivery. */
  ok: boolean;
  /** Populated when ok=false. Short machine/human-readable reason. */
  error?: string;
  /** Optional connector-specific delivery identifier. */
  deliveryId?: string;
}

export interface OutboundConnector {
  /** Stable identifier used by the message_send `channels` param. */
  readonly id: string;
  /** Display name (e.g. "discord", "telegram"). */
  readonly name: string;
  /** Trust level carried by messages arriving via this connector. */
  readonly trustLevel: ConnectorTrustLevel;
  /**
   * Deliver a single message. Implementations should be fire-and-forget
   * from the caller's perspective — resolve the promise once the
   * transport has either confirmed delivery or definitively failed.
   */
  deliver(opts: OutboundDeliverOptions): Promise<OutboundDeliverResult>;
}

const connectors: Map<string, OutboundConnector> = new Map();

/**
 * Register an outbound connector. Replaces any existing connector
 * with the same id.
 */
export function registerOutboundConnector(c: OutboundConnector): void {
  if (!c.id || typeof c.id !== "string") {
    throw new Error("registerOutboundConnector: connector.id is required");
  }
  connectors.set(c.id, c);
}

export function unregisterOutboundConnector(id: string): boolean {
  return connectors.delete(id);
}

export function getOutboundConnector(
  id: string,
): OutboundConnector | undefined {
  return connectors.get(id);
}

export function listOutboundConnectors(): OutboundConnector[] {
  return [...connectors.values()];
}

export function hasOutboundConnector(id: string): boolean {
  return connectors.has(id);
}

/** For tests — clear the registry. */
export function _resetOutboundRegistry(): void {
  connectors.clear();
}
