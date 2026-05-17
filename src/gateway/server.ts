import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Config } from "../config/types.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createRouteHandler } from "./http/routes.js";
import { createConnectionHandler } from "./ws/connection.js";
import { RateLimiter } from "../security/rate-limiter.js";
import { createInferencePipeline } from "../agents/inference.js";
import { createSessionStore } from "../sessions/store.js";
import { createCircuitBreaker, type CircuitBreaker } from "../security/circuit-breaker.js";
import type { AuditLog } from "../security/audit.js";
import {
  startKillTokenSweeper,
  stopKillTokenSweeper,
} from "../security/kill-tokens.js";
import { registerOutboundConnector } from "../connectors/outbound.js";
import { createEchoConnector } from "../connectors/echo.js";
import {
  registerInboundConnector,
  listInboundConnectors,
  type InboundConnector,
  type InboundHandler,
} from "../connectors/inbound.js";
import { createEmailImapConnector } from "../connectors/email-imap.js";
import { setEmailAttachmentLimits } from "../agents/tools/email-attach.js";
import { createBufferSink } from "../connectors/buffer-sink.js";
import { createTeeSink } from "../connectors/tee-sink.js";
import { createWebSocketSink } from "../connectors/ws-sink.js";
import type { ConnectorSink } from "../connectors/types.js";
import type { InferencePipeline } from "../agents/inference.js";
import type { SessionStore } from "../sessions/store.js";
import { parseSlashCommand, getCommand, type CommandContext } from "../commands/registry.js";
import "../commands/handlers.js"; // ensure built-in slash commands are registered
import { humanizeInferenceError } from "./format-error.js";
import { truncateSubject } from "../connectors/email-render.js";
import { createScheduleStore } from "../scheduler/store.js";
import { createSchedulerEngine, type SchedulerEngine } from "../scheduler/engine.js";
import { getWorkspaceRoot } from "../agents/tools/builtins.js";
import { drainAttachments } from "../agents/tools/email-attach.js";
import { appendFabricationNoticeIfNeeded } from "./attachment-claim-lint.js";

export interface Gateway {
  server: Server;
  wss: WebSocketServer;
  circuitBreaker: CircuitBreaker;
  scheduler: SchedulerEngine;
  scheduleStore: ReturnType<typeof createScheduleStore>;
  /**
   * The pipeline's audit log. Exposed on the Gateway so privileged
   * operations outside the inference loop (admin endpoints, scheduler
   * cron runs, kill-token redemption) can record entries into the same
   * tamper-evident chain. Without this, those events would only land
   * in pino logs — not in the canonical security trail.
   */
  auditLog: AuditLog;
  /**
   * The full inference pipeline. Exposed primarily so HTTP routes
   * (e.g. /greenlight, future /admin/status) can inspect provider
   * health via pipeline.getProvider(id) without a parallel registry.
   */
  pipeline: InferencePipeline;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Derive the client IP used to key the pre-upgrade rate limiter. When
 * `trustProxy` is true and an `X-Forwarded-For` header is present,
 * walk the comma-separated chain right-to-left and pick the first hop
 * that is NOT in a private CIDR — that's the closest non-proxy edge
 * we can prove. Otherwise fall back to the socket address. Without
 * this, every request behind a reverse proxy shares one bucket, which
 * collapses the limiter into a single shared budget across all real
 * clients. RT-2026-04-30-008.
 */
const PRIVATE_CIDR_RE =
  /^(?:10\.|192\.168\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i;

export function clientIpForRateLimit(
  req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const raw = req.headers?.["x-forwarded-for"];
    const xff = Array.isArray(raw) ? raw[0] : raw;
    if (typeof xff === "string" && xff.length > 0) {
      const hops = xff.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
      for (let i = hops.length - 1; i >= 0; i--) {
        const hop = hops[i]!;
        if (!PRIVATE_CIDR_RE.test(hop)) return hop;
      }
      // All hops were private — fall through to socket address rather
      // than keying on a meaningless private IP.
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Strip the [CHANNEL CONTEXT — ...][END CHANNEL CONTEXT] prompt-envelope
 * block that email-imap (and other forward-aware connectors) prepend to
 * the body. That block is internal prompt scaffolding, not part of what
 * the user actually wrote — observers showing the inbound on a CLI
 * should see only the user-visible content.
 *
 * If no channel-context block is present (most direct replies), the
 * body is returned unchanged.
 */
const CHANNEL_CONTEXT_BLOCK_RE =
  /^\[CHANNEL CONTEXT[^\]]*\][\s\S]*?\[END CHANNEL CONTEXT\]\s*/;

function stripChannelContextForDisplay(body: string): string {
  return body.replace(CHANNEL_CONTEXT_BLOCK_RE, "").trim();
}

/**
 * Wrap an inbound email subject as untrusted text before interpolating it
 * into the user prompt. The original "[Subject: ${subject}]" framing read
 * like a system label, which a sufficiently jailbroken model could treat
 * as authoritative. The fenced form names the input as untrusted, ties
 * it to the sender, and caps the length + strips control chars so a
 * pathological subject can't run past the closing delimiter.
 *
 * RT-2026-04-30-002.
 */
export function fenceUntrustedSubject(subject: string, sender: string): string {
  // Defend the fence:
  //   1. Strip control characters (\p{Cc}) so a CR/LF can't visually
  //      escape the bracketed block.
  //   2. Replace square brackets with parens so the subject can't carry
  //      a literal `[END UNTRUSTED SUBJECT]` that lets the model treat
  //      attacker text as a peer of the fence rather than content inside.
  //   3. Truncate so a 4 KB subject can't drown the prompt envelope.
  const sanitized = truncateSubject(
    subject
      .replace(/\p{Cc}/gu, " ")
      .replace(/\[/g, "(")
      .replace(/\]/g, ")")
      .trim(),
  );
  return (
    `[UNTRUSTED EMAIL SUBJECT FROM ${sender}: ${sanitized}]\n` +
    `[END UNTRUSTED SUBJECT]\n\n`
  );
}

/**
 * Echo the user's inbound message to live observer sinks (CLI, watcher
 * WebSockets) so a watcher sees both sides of the exchange — not just
 * the agent's reply. The buffer sink is intentionally NOT included:
 * it becomes the SMTP / outbound reply body, and we must not echo the
 * user's own message back to them on the channel they sent it on.
 *
 * Failures inside an observer sink are swallowed — observer fan-out
 * is best-effort and must never break the inbound pipeline.
 */
function emitInboundToObservers(
  observers: ConnectorSink[],
  msg: { sender: string; body: string; subject?: string },
  connectorId: string,
  sessionKey: string,
): void {
  if (observers.length === 0) return;
  const displayBody = stripChannelContextForDisplay(msg.body);
  const subjectLine = msg.subject ? `subject: ${msg.subject}\n` : "";
  const text =
    `\n──── inbound ${connectorId} ← ${msg.sender} ────\n` +
    subjectLine +
    displayBody +
    `\n────────────────────────────────────────\n`;
  for (const obs of observers) {
    try {
      obs.sendToken(text, sessionKey);
    } catch {
      // Best-effort fan-out. A misbehaving observer must not cascade
      // into the inbound path.
    }
  }
}

/**
 * Build the inbound handler closure that all InboundConnectors share.
 *
 * For each inbound message we:
 *   1. Derive a stable session key from the connector id + sender so
 *      one external party always reuses the same conversation history.
 *   2. Load (or create) the session.
 *   3. Run pipeline.handleTurn with a BufferSink that captures the
 *      streamed reply tokens in memory.
 *   4. Hand the buffered text back so the connector can deliver it
 *      through its own transport (SMTP for email, file write for
 *      dropbox, etc.).
 *
 * Errors during inference are surfaced in the reply body so the user
 * actually sees them on the channel they're using — silent failure
 * would be much worse than an apologetic message.
 */
export function buildInboundHandler(
  config: Config,
  pipeline: InferencePipeline,
  store: SessionStore,
  connectorId: string,
  circuitBreaker?: CircuitBreaker,
  /**
   * Optional supplier of "observer" sinks that should mirror the inbound
   * turn's events. Wired by the gateway to surface live email/discord
   * exchanges to any connected CLI/WebSocket clients — without this
   * fan-out, the inbound path is silent from a watcher's perspective.
   * Resolved per-turn so newly-connected clients are picked up.
   */
  getObserverSinks?: () => ConnectorSink[],
): InboundHandler {
  return async (msg) => {
    // Per-thread session keying when the connector supplies a threadId
    // (e.g. email-imap passes the References-root id). Without this,
    // every message from a given sender shares one transcript, so a
    // math thread bleeds answers into an unrelated budget thread.
    // Connectors that don't have a thread concept (echo, signal-cli)
    // pass undefined and keep the legacy sender-only key.
    const sessionKey = msg.threadId
      ? `inbound:${connectorId}:${msg.sender}:${msg.threadId}`
      : `inbound:${connectorId}:${msg.sender}`;
    const agentId = config.agents[0]?.id ?? "default";

    // Speculative session-file prefetch — warms OS page cache while we
    // still have other per-message work to do. The store.load() below
    // reads the same file; with the OS cache populated, it hits memory
    // instead of disk. Fire-and-forget — store.prefetch never throws.
    void store.prefetch(sessionKey);

    let session = await store.load(sessionKey);
    if (!session) {
      session = store.create(sessionKey, agentId, connectorId, msg.sender);
    }

    const bufferSink = createBufferSink();
    // Tee to any live observers (e.g. CLI WebSocket clients) so they
    // see the inbound exchange happening in real time. Buffer is always
    // primary — its captured text becomes the connector reply.
    const observers = getObserverSinks?.() ?? [];
    const sink: ConnectorSink = observers.length > 0
      ? createTeeSink([bufferSink, ...observers])
      : bufferSink;

    // Show the inbound to live observers BEFORE the slash-command path
    // OR the agent-reply path runs. This closes a record-keeping gap:
    // without it, the CLI shows only the agent's outbound, never the
    // user's inbound, and watchers see a one-sided conversation.
    // Observers only — buffer sink is excluded so the user's own
    // message never round-trips back through the SMTP reply body.
    emitInboundToObservers(observers, msg, connectorId, sessionKey);

    // Slash command interception. If the message body starts with "/",
    // parse it as a command and route through the command registry
    // instead of running inference. This makes /model swap, /away,
    // /back, /help, etc. usable from the inbox — which is *the* point
    // of having an inbound channel: remote control, not just chat.
    //
    // Subject is intentionally ignored for command detection — only
    // the body counts. That avoids accidental command triggers from
    // forwarded threads where someone else's subject contains a slash.
    const trimmed = msg.body.trim();
    if (trimmed.startsWith("/")) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        const cmd = getCommand(parsed.name);
        if (!cmd) {
          // Drain even on early-exit paths so a previous turn's queued
          // attachments do not silently roll forward to the next reply.
          drainAttachments(sessionKey);
          return {
            body: `Unknown command: /${parsed.name}\n\nTry /help for a list of available commands.`,
          };
        }
        const ctx: CommandContext = {
          sink,
          sessionKey,
          frameId: `inbound-${Date.now()}`,
          config,
          store,
          pipeline,
          circuitBreaker,
          args: parsed.args,
        };
        try {
          const result = await cmd.handler(ctx);
          logger.info(
            { sessionKey, connectorId, command: parsed.name, outputLen: result.output.length },
            "inbound: slash command executed",
          );
          drainAttachments(sessionKey);
          return { body: result.output };
        } catch (err) {
          const message = formatErrorMessage(err);
          logger.error(
            { err: message, sessionKey, connectorId, command: parsed.name },
            "inbound: slash command threw",
          );
          drainAttachments(sessionKey);
          return { body: `(crabmeat command error: ${message})` };
        }
      }
    }

    try {
      // Forward the message body as the user turn. Subject (if any) is
      // prepended via fenceUntrustedSubject — the original "[Subject:]"
      // framing read like a system label, which a sufficiently permissive
      // model could treat as authoritative. RT-2026-04-30-002.
      //
      // Only prepend on the FIRST turn of a session. On follow-up turns
      // the prior transcript already carries the thread's context, AND
      // the fenced subject sits inches from the new user message — close
      // enough to compete with prior assistant turns for anaphora
      // resolution. A subject like "thread anchor 001" with a follow-up
      // "what's that times three?" gets answered "001 × 3 = 003" instead
      // of "12" because the numeric token in the subject is more recent
      // in the prompt than the prior reply. The injection defense is
      // most valuable on first contact (where the subject is the only
      // signal); on follow-ups, transcript context dominates and the
      // prepend is noise.
      const isFirstTurn = session.transcript.length === 0;
      const userContent = msg.subject && isFirstTurn
        ? fenceUntrustedSubject(msg.subject, msg.sender) + msg.body
        : msg.body;
      await pipeline.handleTurn(sink, session, userContent, store);
    } catch (err) {
      const message = formatErrorMessage(err);
      logger.error(
        { err: message, sessionKey, connectorId },
        "inbound: handleTurn threw",
      );
      drainAttachments(sessionKey);
      return { body: `(crabmeat encountered an error: ${humanizeInferenceError(message)})` };
    }

    const result = bufferSink.getResult();
    let body = result.text.trim();
    if (!body && result.errors.length > 0) {
      // Raw provider errors leak Go stack noise and the entire offending
      // JSON blob — humanize for the user before sending. Full detail
      // remains in gateway logs for debugging.
      const raw = result.errors[0]!.message;
      logger.warn({ sessionKey, connectorId, raw }, "inbound: surfacing inference error to user");
      body = `(crabmeat error: ${humanizeInferenceError(raw)})`;
    }
    if (!body) {
      // Last-resort fallback. Most empty-text turns now come back through
      // the EMPTY_RESPONSE error path above; this only fires if the agent
      // produced no text AND no error (rare, but possible if a connector
      // sink swallows tokens). Give the user something they can act on
      // rather than a vague "no response" stub.
      logger.warn({ sessionKey, connectorId }, "inbound: empty body and no errors");
      body =
        "(crabmeat produced no reply — the model may have stalled. Try /model swap to a different model, or resend.)";
    }

    // Drain any attachments the agent staged via email_attach. The
    // queue is per-session, so we always drain — even when the body is
    // a fallback or error string — to prevent stale files from a prior
    // failed turn from being silently delivered on the next one.
    const queued = drainAttachments(sessionKey);
    const attachments = queued.length > 0
      ? queued.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        }))
      : undefined;
    if (attachments) {
      logger.info(
        {
          sessionKey,
          connectorId,
          attachmentCount: attachments.length,
          attachmentBytes: attachments.reduce((n, a) => n + a.content.length, 0),
          attachmentNames: attachments.map((a) => a.filename),
        },
        "inbound: attaching staged files to reply",
      );
    }

    // Post-turn lint: if the body narrates an attachment but nothing was
    // actually staged, append a factual correction notice. Catches the
    // 2026-04-24 "Cybersec report" failure mode at the send seam — model
    // independent, so it works even when prompt-layer honesty rules get
    // ignored on smaller models.
    const lint = appendFabricationNoticeIfNeeded(body, queued.length);
    if (lint.intercepted) {
      logger.warn(
        {
          sessionKey,
          connectorId,
          reason: lint.reason,
          bodyPreview: body.slice(0, 240),
        },
        "inbound: attachment-claim fabrication detected — appended correction notice",
      );
      body = lint.body;
    }

    return { body, attachments };
  };
}

function registerConfiguredConnectors(
  config: Config,
  pipeline: InferencePipeline,
  store: SessionStore,
  circuitBreaker?: CircuitBreaker,
  /**
   * Supplier of WebSocket-based observer sinks. Resolved per-turn so
   * newly-connected CLI clients can join an in-flight inbound exchange.
   * Without this, inbound (email/discord) turns are invisible to watchers.
   */
  getObserverSinks?: () => ConnectorSink[],
): void {
  // Tests construct Config shapes by hand and may omit connectors.
  const c = config.connectors ?? { echo: false };
  if (c.echo) {
    try {
      registerOutboundConnector(createEchoConnector());
      logger.info("Registered echo outbound connector (dev-only)");
    } catch (err) {
      logger.error({ err }, "Failed to register echo connector");
    }
  }
  if (c.emailImap) {
    try {
      // Apply per-connector attachment caps to the global email_attach
      // tool limits. Schema enforces total >= per-file and the upper
      // bounds (25 MB / 50 MB), so the setter trusts both numbers.
      setEmailAttachmentLimits({
        maxBytes: c.emailImap.attachmentMaxBytesPerFile,
        totalMaxBytes: c.emailImap.attachmentMaxBytesTotal,
      });
      const connector = createEmailImapConnector({
        ...c.emailImap,
        auditLog: pipeline.auditLog,
      });
      registerInboundConnector(connector);
      const handler = buildInboundHandler(config, pipeline, store, connector.id, circuitBreaker, getObserverSinks);
      // Fire-and-forget: start() resolves once the IMAP connection is
      // up and the poll timer is scheduled. We don't block gateway
      // startup on it, but we do log failures loudly.
      void connector.start(handler).catch((err) => {
        logger.error(
          { err: formatErrorMessage(err) },
          "email-imap: failed to start — check .crabmeat/local.json credentials",
        );
      });
      logger.info(
        { id: connector.id, user: c.emailImap.user },
        "Registered email-imap inbound connector",
      );
    } catch (err) {
      logger.error(
        { err: formatErrorMessage(err) },
        "Failed to register email-imap connector — check .crabmeat/local.json",
      );
    }
  }
}

async function stopInboundConnectors(): Promise<void> {
  const all: InboundConnector[] = listInboundConnectors();
  for (const c of all) {
    try {
      await c.stop();
    } catch (err) {
      logger.warn(
        { err: formatErrorMessage(err), id: c.id },
        "Error stopping inbound connector",
      );
    }
  }
}

export function createGateway(config: Config): Gateway {
  const { host, port } = config.gateway;

  const store = createSessionStore(config.session);
  const circuitBreaker = createCircuitBreaker();
  const pipeline = createInferencePipeline(config, circuitBreaker);

  const connHandler = createConnectionHandler(pipeline, store, circuitBreaker);

  // Scheduler engine — checks cron schedules every 60s
  const wsRoot = getWorkspaceRoot();
  const scheduleStore = createScheduleStore(wsRoot);
  const scheduler = createSchedulerEngine(
    scheduleStore,
    pipeline,
    store,
    wsRoot,
    pipeline.auditLog,
  );

  let gateway: Gateway;

  const routeHandler = createRouteHandler(config, () => gateway);

  const server = createServer((req, res) => {
    routeHandler(req, res);
  });

  // Pre-upgrade rate limiter — rejects at HTTP level before WebSocket
  // upgrade completes, saving kernel resources (TLS state, TCP socket).
  const upgradeRateLimiter = new RateLimiter({
    windowMs: 60_000,
    maxAttempts: 30,
    lockoutMs: 30_000,
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const ip = clientIpForRateLimit(req, config.gateway.trustProxy);
    if (!upgradeRateLimiter.check(ip)) {
      logger.warn({ ip }, "Pre-upgrade rate limited — rejecting before WebSocket handshake");
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    // Reject new connections when circuit breaker is tripped
    if (!circuitBreaker.isAllowed()) {
      ws.close(4503, "Service temporarily unavailable — circuit breaker open");
      return;
    }

    connHandler.handle(ws, req, config).catch((err) => {
      logger.error({ err }, "Unhandled error in connection handler");
      ws.close(4500, "Internal error");
    });
  });

  gateway = {
    server,
    wss,
    circuitBreaker,
    scheduler,
    scheduleStore,
    auditLog: pipeline.auditLog,
    pipeline,

    start() {
      return new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            reject(new Error(
              `Port ${port} is already in use. Kill the other process or change the port in config.`,
            ));
          } else {
            reject(err);
          }
        };

        server.once("error", onError);
        server.listen(port, host, () => {
          // Remove the startup error handler so it doesn't fire on
          // later errors with a stale reject callback.
          server.removeListener("error", onError);
          logger.info({ host, port }, "Gateway listening");

          // Start scheduler engine after gateway is listening
          scheduler.start();

          // Start the kill-token sweeper so expired tokens get purged.
          startKillTokenSweeper();

          // Register outbound connectors from config. Failures here are
          // logged but not fatal — message_send simply won't have that
          // channel available. Inbound connectors (email-imap, etc.)
          // also start here so they can begin polling once the gateway
          // is alive.
          //
          // The observer-sink supplier wraps each currently-connected
          // WebSocket client in a fresh WebSocketSink so inbound (email,
          // discord) turns get mirrored to live CLI watchers in real
          // time. Resolved per-turn so clients that connect mid-session
          // start receiving events on the next inbound message.
          const getObserverSinks = (): ConnectorSink[] => {
            const out: ConnectorSink[] = [];
            for (const client of wss.clients) {
              if (client.readyState === client.OPEN) {
                out.push(createWebSocketSink(client));
              }
            }
            return out;
          };
          registerConfiguredConnectors(config, pipeline, store, circuitBreaker, getObserverSinks);

          resolve();
        });
      });
    },

    stop() {
      return new Promise<void>((resolve, reject) => {
        // Stop scheduler first
        scheduler.stop();
        stopKillTokenSweeper();
        circuitBreaker.destroy();
        upgradeRateLimiter.destroy();

        // Stop inbound connectors in the background — we don't block
        // shutdown on IMAP logout because Gmail can be slow to ack.
        void stopInboundConnectors();

        for (const client of wss.clients) {
          client.close(1001, "Server shutting down");
        }

        connHandler.destroy();

        wss.close((wsErr) => {
          if (wsErr) logger.error({ err: wsErr }, "Error closing WebSocket server");

          server.close((httpErr) => {
            if (httpErr) {
              reject(httpErr);
            } else {
              logger.info("Gateway stopped");
              resolve();
            }
          });
        });
      });
    },
  };

  return gateway;
}
