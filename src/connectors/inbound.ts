/**
 * Inbound connector registry — the symmetric counterpart to outbound.ts.
 *
 * An InboundConnector listens on some external transport (IMAP poll, a
 * filesystem watcher, signal-cli, etc.) and, when a message arrives,
 * invokes a handler the gateway provides at start() time. The handler
 * is responsible for routing the message into the inference pipeline
 * (typically by spinning up a session keyed to the sender and running
 * pipeline.handleTurn on a BufferSink) and returning the agent's reply
 * for the connector to deliver back through the same transport.
 *
 * Design notes:
 *
 * - The handler shape is intentionally minimal: {sender, body, threadId?}
 *   in, {body} out. Connectors translate to/from their native message
 *   formats. Threading metadata (Message-Id, In-Reply-To for email,
 *   timestamps for signal) is opaque to the pipeline — connectors stash
 *   what they need internally to thread the reply.
 *
 * - The handler is *async* and returns the reply text. The connector
 *   then sends that reply via its native send path (SMTP for email,
 *   another file write for dropbox, etc.). This keeps the connector in
 *   charge of "what does a reply look like on this channel", and keeps
 *   the pipeline blissfully unaware of channel semantics.
 *
 * - sender is treated as untrusted user input — never put it in shell
 *   commands or filesystem paths without sanitization. Connectors are
 *   expected to validate it against an allow-list before calling the
 *   handler at all (e.g. email-imap drops messages from non-whitelisted
 *   addresses before we get here).
 *
 * - "Outbound" is one direction (agent → channel). "Inbound" is the
 *   other (channel → agent → channel). They are kept as separate
 *   registries because not every channel needs to be both — a Discord
 *   webhook is outbound-only; an IMAP mailbox is bidirectional via
 *   SMTP; a filesystem dropbox might be inbound-only with the CLI
 *   handling output. The two registries can be mixed and matched.
 */

import type { ConnectorTrustLevel } from "./types.js";

export interface InboundMessage {
  /** External identifier of the sender (email address, username, etc.). */
  sender: string;
  /** The plain-text body of the message. Connectors should strip HTML/quotes. */
  body: string;
  /** Subject or title line, when the channel has one. Optional. */
  subject?: string;
  /**
   * Opaque thread identifier the connector uses to route a reply back
   * to the same conversation. The pipeline never inspects this; the
   * connector hands it back to itself when delivering the reply.
   */
  threadId?: string;
}

/**
 * A file the agent staged via `email_attach` (or a future equivalent
 * for other channels) to be delivered alongside the reply body. The
 * connector decides how to render this on its native transport — for
 * email-imap, this maps to nodemailer's `attachments` array.
 */
export interface InboundAttachment {
  /** Display filename the recipient sees. Already sanitized by the tool. */
  filename: string;
  /** Raw file bytes. Held in memory; capped upstream. */
  content: Buffer;
  /** MIME type guess; connector falls back to application/octet-stream. */
  contentType?: string;
}

export interface InboundReply {
  /** The agent's reply text to deliver back through the same channel. */
  body: string;
  /**
   * Optional files to attach to the reply. Connectors that do not
   * support attachments should ignore this field rather than error.
   */
  attachments?: InboundAttachment[];
}

/**
 * Handler signature passed to InboundConnector.start(). The connector
 * invokes this once per inbound message and awaits the reply before
 * sending it back through the channel.
 */
export type InboundHandler = (msg: InboundMessage) => Promise<InboundReply>;

export interface InboundConnector {
  /** Stable identifier — used for logging and registry lookups. */
  readonly id: string;
  /** Display name (e.g. "email-imap", "signal-cli", "dropbox"). */
  readonly name: string;
  /** Trust level applied to messages arriving via this connector. */
  readonly trustLevel: ConnectorTrustLevel;

  /**
   * Begin listening / polling. The connector will call `handler` for
   * each inbound message and is responsible for delivering the returned
   * reply back through its own transport. Resolves once the listener
   * is up (e.g. IMAP connection established and first poll scheduled).
   */
  start(handler: InboundHandler): Promise<void>;

  /** Graceful shutdown — close sockets, cancel timers, drain queues. */
  stop(): Promise<void>;
}

const connectors: Map<string, InboundConnector> = new Map();

export function registerInboundConnector(c: InboundConnector): void {
  if (!c.id || typeof c.id !== "string") {
    throw new Error("registerInboundConnector: connector.id is required");
  }
  connectors.set(c.id, c);
}

export function unregisterInboundConnector(id: string): boolean {
  return connectors.delete(id);
}

export function getInboundConnector(id: string): InboundConnector | undefined {
  return connectors.get(id);
}

export function listInboundConnectors(): InboundConnector[] {
  return [...connectors.values()];
}

export function hasInboundConnector(id: string): boolean {
  return connectors.has(id);
}

/** For tests — clear the registry. */
export function _resetInboundRegistry(): void {
  connectors.clear();
}
