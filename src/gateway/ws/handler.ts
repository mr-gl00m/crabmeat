import type { WebSocket } from "ws";
import type { Config } from "../../config/types.js";
import type { InferencePipeline } from "../../agents/inference.js";
import type { SessionStore } from "../../sessions/store.js";
import type { CircuitBreaker } from "../../security/circuit-breaker.js";
import { resolveRoute } from "../../routing/resolve.js";
import { trimTranscript } from "../../sessions/transcript.js";
import { logger } from "../../infra/logger.js";
import { formatError } from "../../infra/errors.js";
import { createHookLimiter } from "../auth/rate-limit.js";
import {
  requestFrameSchema,
  makeResponse,
  makeErrorResponse,
  makeErrorEvent,
  makeTokenEvent,
  makeDoneEvent,
  makeCommandRecognizedEvent,
  makeUserQuestionEvent,
  makeMessageOutboundMirrorEvent,
  makeInputQueuedEvent,
  makeSessionEvictedEvent,
  POST_AUTH_MAX_BYTES,
} from "./protocol.js";
import {
  enqueuePendingInput,
  clearPendingInput,
  isControlKillToken,
  pendingInputCount,
  MAX_PENDING_CONTENT_LEN,
} from "../../agents/pending-input.js";
import {
  registerAskUserSender,
  unregisterAskUserSender,
  receiveAnswer as receiveAskUserAnswer,
  hasPendingForSession as hasPendingAskUserForSession,
} from "../../agents/tools/ask-user-broker.js";
import {
  registerOutboundMirrorSink,
  unregisterOutboundMirrorSink,
} from "../../agents/tools/message-mirror-broker.js";
import { checkByteSize, stripNullBytes } from "../../security/sanitize.js";
import { normalizeInput } from "../../security/normalize.js";
import { createWebSocketSink } from "../../connectors/ws-sink.js";
import { parseSlashCommand, getCommand } from "../../commands/registry.js";
import type { CommandContext } from "../../commands/registry.js";
import { handleLayer2 } from "../../agents/layer2/router.js";
import type { Layer2Config } from "../../config/types.js";
import { runArbiterTurn } from "../../agents/arbiter-bridge.js";
import { getWorkspaceRoot } from "../../agents/tools/builtins.js";
// Side-effect import: registers all built-in commands
import "../../commands/handlers.js";

// ── In-message command detection ─────────────────────────
// Messages starting with these tokens are intercepted before inference.
// --killbot  : trip the circuit breaker (no more AI responses until reset)
// --resetbot : reset the breaker, re-allow inference
// --bothelp  : list available commands

const KILL_PATTERN = /^\s*--killbot\b/i;
const RESET_PATTERN = /^\s*--resetbot\b/i;
const HELP_PATTERN = /^\s*--bothelp\b/i;

/**
 * Handle post-auth messages from an authenticated WebSocket client.
 * Dispatches chat.send to the inference pipeline and chat.history
 * to the session store.
 */
/** Default idle timeout: 5 minutes. Connections with no messages are closed. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Max sessions tracked per connection to prevent unbounded Set growth. */
const MAX_OWNED_SESSIONS = 100;

/**
 * Test-only override of MAX_OWNED_SESSIONS so the eviction code path can
 * be exercised within a single connection's message-rate-limit budget
 * (100 messages/min) — see RT-2026-04-30-007 regression tests. Production
 * call sites omit this and the real cap applies.
 */
export interface AttachHandlerOpts {
  maxOwnedSessions?: number;
}

export function attachMessageHandler(
  ws: WebSocket,
  config: Config,
  pipeline: InferencePipeline,
  store: SessionStore,
  circuitBreaker?: CircuitBreaker,
  opts: AttachHandlerOpts = {},
): void {
  const ownedSessionsCap = opts.maxOwnedSessions ?? MAX_OWNED_SESSIONS;
  // Track which sessions this connection has accessed (ownership set).
  // Capped to prevent unbounded growth from channel/peer rotation.
  const ownedSessions = new Set<string>();
  // Per-connection message rate limiter
  const messageLimiter = createHookLimiter();
  const clientId = crypto.randomUUID();

  // Idle timeout — close connections that send no messages
  let idleTimer = setTimeout(() => {
    logger.info({ clientId }, "Closing idle WebSocket connection");
    ws.close(4408, "Idle timeout");
  }, IDLE_TIMEOUT_MS);
  if (idleTimer.unref) idleTimer.unref();

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info({ clientId }, "Closing idle WebSocket connection");
      ws.close(4408, "Idle timeout");
    }, IDLE_TIMEOUT_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    resetIdleTimer();
    // Check post-auth message rate limit
    if (!messageLimiter.check(clientId)) {
      ws.send(
        JSON.stringify(makeErrorEvent("RATE_LIMITED", "Too many messages — slow down")),
      );
      return;
    }

    const raw = Buffer.isBuffer(data) ? data.toString() : Buffer.from(data as ArrayBuffer).toString();

    // Size check (post-auth)
    if (!checkByteSize(raw, POST_AUTH_MAX_BYTES)) {
      ws.send(
        JSON.stringify(makeErrorEvent("FRAME_TOO_LARGE", "Frame exceeds 1MB")),
      );
      return;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripNullBytes(raw));
    } catch {
      ws.send(
        JSON.stringify(makeErrorEvent("INVALID_JSON", "Invalid JSON")),
      );
      return;
    }

    // Validate request frame
    const frameResult = requestFrameSchema.safeParse(parsed);
    if (!frameResult.success) {
      ws.send(
        JSON.stringify(
          makeErrorEvent("INVALID_FRAME", "Invalid request frame"),
        ),
      );
      return;
    }

    const frame = frameResult.data;

    // Dispatch by method (async handlers use void + catch)
    switch (frame.method) {
      case "connect":
        ws.send(
          JSON.stringify(
            makeErrorResponse(frame.id, "ALREADY_CONNECTED", "Already connected"),
          ),
        );
        break;

      case "chat.send":
        void handleChatSend(ws, frame.id, frame.params, config, pipeline, store, ownedSessions, circuitBreaker, ownedSessionsCap).catch(
          (err) => {
            const { code, message } = formatError(err);
            ws.send(JSON.stringify(makeErrorResponse(frame.id, code, message)));
          },
        );
        break;

      case "chat.history":
        void handleChatHistory(ws, frame.id, frame.params, config, store, ownedSessions).catch(
          (err) => {
            const { code, message } = formatError(err);
            ws.send(JSON.stringify(makeErrorResponse(frame.id, code, message)));
          },
        );
        break;

      case "command.exec":
        void handleCommandExec(ws, frame.id, frame.params, config, pipeline, store, circuitBreaker).catch(
          (err) => {
            const { code, message } = formatError(err);
            ws.send(JSON.stringify(makeErrorResponse(frame.id, code, message)));
          },
        );
        break;

      case "chat.queue": {
        handleChatQueue(
          ws,
          frame.id,
          frame.params,
          config,
          ownedSessions,
          circuitBreaker,
        );
        break;
      }

      case "user.answer": {
        const { sessionId, questionId, answer, optionIndex } = frame.params;
        if (!ownedSessions.has(sessionId)) {
          ws.send(
            JSON.stringify(
              makeErrorResponse(
                frame.id,
                "SESSION_ACCESS_DENIED",
                "Not authorized to answer on this session",
              ),
            ),
          );
          break;
        }
        const delivered = receiveAskUserAnswer(questionId, sessionId, {
          answer,
          ...(optionIndex !== undefined && { optionIndex }),
        });
        if (!delivered) {
          ws.send(
            JSON.stringify(
              makeErrorResponse(
                frame.id,
                "QUESTION_NOT_PENDING",
                "No pending question with that id (already answered or timed out)",
              ),
            ),
          );
          break;
        }
        ws.send(JSON.stringify(makeResponse(frame.id, { delivered: true })));
        break;
      }

      default:
        ws.send(
          JSON.stringify(
            makeErrorResponse(
              (frame as { id: string }).id,
              "UNKNOWN_METHOD",
              "Unknown method",
            ),
          ),
        );
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(idleTimer);
    messageLimiter.destroy();
    // Release ask_user senders for every session this connection owned so
    // any parked tool calls reject with "client disconnected" instead of
    // hanging until their timeout fires.
    const lifecycleHooks = pipeline.getLifecycleHooks?.();
    for (const sessionKey of ownedSessions) {
      unregisterAskUserSender(sessionKey);
      unregisterOutboundMirrorSink(sessionKey);
      if (lifecycleHooks) {
        // Fire-and-forget: close callbacks are synchronous, so we
        // don't await. The registry is soft-fail so a slow hook
        // can't stall disconnection.
        void lifecycleHooks.fire("session_end", {
          sessionId: sessionKey,
          reason: "disconnect",
        });
      }
    }
    ownedSessions.clear();
    logger.info({ code, reason: reason?.toString() ?? "" }, "Client disconnected");
  });

  ws.on("error", (err) => {
    logger.error({ err }, "WebSocket error");
  });
}

/**
 * chat.queue — interrupt-lane handler.
 *
 * Unlike chat.send this never runs inference. It either:
 *   1. Fast-paths a control token (--killbot/--kill/…) by tripping
 *      the breaker immediately and clearing the pending buffer, or
 *   2. Enqueues the content into the per-session pending buffer
 *      so the agent loop picks it up at the next iteration boundary.
 *
 * Returns responses synchronously — this path MUST NOT block on
 * inference, since the whole point is to land while inference is
 * stuck in a loop.
 */
function handleChatQueue(
  ws: WebSocket,
  frameId: string,
  params: { channelId?: string; peerId?: string; content: string },
  config: Config,
  ownedSessions: Set<string>,
  circuitBreaker?: CircuitBreaker,
): void {
  const route = resolveRoute(
    { channelId: params.channelId, peerId: params.peerId },
    config.routing,
  );
  const sessionKey = route.sessionKey;

  // Ownership gate: only a session-owner connection may queue into it.
  // If this is the first queue for this session, the owner hasn't even
  // started a chat turn yet — in that case, reject. Queue is strictly
  // for mid-turn interrupts.
  if (!ownedSessions.has(sessionKey)) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(
          frameId,
          "SESSION_NOT_ACTIVE",
          "chat.queue requires an active session (send a chat.send first)",
        ),
      ),
    );
    return;
  }

  const content = params.content;

  // Empty content rejected here (not at schema level) so we can return
  // a proper response with replyTo instead of a top-level error event.
  if (content.length === 0) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(
          frameId,
          "EMPTY_INPUT",
          "Queued input must be non-empty",
        ),
      ),
    );
    return;
  }

  // Fast path: control kill token. Trip the breaker synchronously
  // and clear the queue — a queued kill that has to wait for the
  // loop to drain would defeat the point.
  if (isControlKillToken(content)) {
    const cleared = clearPendingInput(sessionKey);
    if (circuitBreaker) {
      circuitBreaker.trip();
      logger.warn(
        { source: "chat.queue", sessionKey, cleared },
        "Circuit breaker tripped via queued --killbot",
      );
    }
    ws.send(
      JSON.stringify(
        makeResponse(frameId, {
          acknowledged: true,
          kind: "control",
          breakerTripped: !!circuitBreaker,
          cleared,
        }),
      ),
    );
    ws.send(
      JSON.stringify(
        makeInputQueuedEvent({
          sessionId: sessionKey,
          kind: "control",
          position: 0,
          preview: content.trim(),
        }),
      ),
    );
    return;
  }

  // Normal enqueue path.
  if (content.length > MAX_PENDING_CONTENT_LEN) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(
          frameId,
          "INPUT_TOO_LONG",
          `Queued input exceeds ${MAX_PENDING_CONTENT_LEN} chars`,
        ),
      ),
    );
    return;
  }

  const position = enqueuePendingInput(sessionKey, content);
  if (position < 0) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(
          frameId,
          "QUEUE_FULL",
          "Pending input buffer full for this session",
        ),
      ),
    );
    return;
  }

  ws.send(
    JSON.stringify(
      makeResponse(frameId, {
        acknowledged: true,
        kind: "queued",
        position,
        pending: pendingInputCount(sessionKey),
      }),
    ),
  );
  ws.send(
    JSON.stringify(
      makeInputQueuedEvent({
        sessionId: sessionKey,
        kind: "queued",
        position,
        preview: content.slice(0, 120),
      }),
    ),
  );
}

async function handleChatSend(
  ws: WebSocket,
  frameId: string,
  params: { channelId?: string; peerId?: string; content: string },
  config: Config,
  pipeline: InferencePipeline,
  store: SessionStore,
  ownedSessions: Set<string>,
  circuitBreaker?: CircuitBreaker,
  ownedSessionsCap: number = MAX_OWNED_SESSIONS,
): Promise<void> {
  const content = params.content;

  // ── Session ownership (hoisted above early-return control paths) ──
  // Claim ownership BEFORE the slash-command / in-message control
  // branches, so sending `--bothelp` or `--killbot` as your first
  // message still lets follow-up `chat.queue` frames target this
  // session. Otherwise the interrupt lane only works after a real
  // inference turn has started, which is exactly backwards.
  const route = resolveRoute(
    { channelId: params.channelId, peerId: params.peerId },
    config.routing,
  );
  if (
    ownedSessions.size >= ownedSessionsCap &&
    !ownedSessions.has(route.sessionKey)
  ) {
    // Refuse to evict any session whose ask_user is still pending —
    // silently dropping the parent's question would leave the agent
    // hanging on a reply that can never arrive. Reject this chat.send
    // with SESSION_LIMIT_REACHED instead. RT-2026-04-30-007.
    let oldest: string | undefined;
    for (const candidate of ownedSessions) {
      if (!hasPendingAskUserForSession(candidate)) {
        oldest = candidate;
        break;
      }
    }
    if (oldest === undefined) {
      ws.send(
        JSON.stringify(
          makeErrorResponse(
            frameId,
            "SESSION_LIMIT_REACHED",
            `Connection holds ${ownedSessionsCap} sessions, all with pending ask_user prompts. ` +
              `Answer one (or let it time out) before opening a new session.`,
          ),
        ),
      );
      return;
    }
    ownedSessions.delete(oldest);
    unregisterAskUserSender(oldest);
    unregisterOutboundMirrorSink(oldest);
    ws.send(JSON.stringify(makeSessionEvictedEvent(oldest)));
  }
  const firstTimeForSession = !ownedSessions.has(route.sessionKey);
  ownedSessions.add(route.sessionKey);

  if (firstTimeForSession) {
    registerAskUserSender(route.sessionKey, (payload) => {
      try {
        ws.send(JSON.stringify(makeUserQuestionEvent(payload)));
      } catch (err) {
        logger.warn({ err, sessionKey: route.sessionKey }, "Failed to send user.question event");
      }
    });
    registerOutboundMirrorSink(route.sessionKey, (event) => {
      try {
        ws.send(
          JSON.stringify(
            makeMessageOutboundMirrorEvent({
              sessionId: event.sessionKey,
              messageId: event.messageId,
              channel: event.channel,
              content: event.content,
              delivered: event.delivered,
              error: event.error,
              killUrl: event.killUrl,
              timestamp: event.timestamp,
            }),
          ),
        );
      } catch (err) {
        logger.warn(
          { err, sessionKey: route.sessionKey },
          "Failed to send message.outbound mirror event",
        );
      }
    });
  }

  // ── Slash command interception ──────────────────────────
  const slashCmd = parseSlashCommand(content);
  if (slashCmd) {
    const cmd = getCommand(slashCmd.name);
    if (cmd) {
      const sink = createWebSocketSink(ws);
      const ctx: CommandContext = {
        sink,
        sessionKey: route.sessionKey,
        frameId,
        config,
        store,
        pipeline,
        circuitBreaker,
        args: slashCmd.args,
      };
      // Signal the client immediately so the UI can gray out the command
      ws.send(JSON.stringify(makeCommandRecognizedEvent(slashCmd.name, frameId)));
      ws.send(JSON.stringify(makeResponse(frameId, { status: "streaming", sessionKey: "__command" })));
      const result = await cmd.handler(ctx);
      ws.send(JSON.stringify(makeTokenEvent(result.output, "__command")));
      ws.send(JSON.stringify(makeDoneEvent("__command", frameId)));
      return;
    }
    // Unknown slash command — fall through to inference (user may want to say "/something" to the agent)
  }

  // ── In-message control commands ────────────────────────
  if (HELP_PATTERN.test(content)) {
    ws.send(JSON.stringify(makeResponse(frameId, { status: "streaming", sessionKey: "__control" })));
    ws.send(JSON.stringify(makeTokenEvent(
      "**CrabMeat control commands:**\n" +
      "  `--killbot`  — trip the circuit breaker (halts all AI inference)\n" +
      "  `--resetbot` — reset the breaker (re-enables inference)\n" +
      "  `--bothelp`  — show this help",
      "__control",
    )));
    ws.send(JSON.stringify(makeDoneEvent("__control", frameId)));
    return;
  }

  if (KILL_PATTERN.test(content)) {
    if (circuitBreaker) {
      circuitBreaker.trip();
      logger.warn({ source: "in-message" }, "Circuit breaker tripped via --killbot");
    }
    ws.send(JSON.stringify(makeResponse(frameId, { status: "streaming", sessionKey: "__control" })));
    ws.send(JSON.stringify(makeTokenEvent(
      circuitBreaker
        ? "**[KILL SWITCH ENGAGED]** Circuit breaker tripped. AI inference is halted. Send `--resetbot` to re-enable."
        : "**[KILL SWITCH]** No circuit breaker configured — cannot trip.",
      "__control",
    )));
    ws.send(JSON.stringify(makeDoneEvent("__control", frameId)));
    return;
  }

  if (RESET_PATTERN.test(content)) {
    if (circuitBreaker) {
      circuitBreaker.reset();
      logger.info({ source: "in-message" }, "Circuit breaker reset via --resetbot");
    }
    ws.send(JSON.stringify(makeResponse(frameId, { status: "streaming", sessionKey: "__control" })));
    ws.send(JSON.stringify(makeTokenEvent(
      circuitBreaker
        ? "**[RESET]** Circuit breaker reset. AI inference is re-enabled."
        : "**[RESET]** No circuit breaker configured.",
      "__control",
    )));
    ws.send(JSON.stringify(makeDoneEvent("__control", frameId)));
    return;
  }
  // Ownership + ask_user/outbound-mirror registration happened at the
  // top of this function, above the control-command early returns.

  // 2. Load or create session
  const existingSession = await store.load(route.sessionKey);
  const isNewSession = !existingSession;
  const session =
    existingSession ??
    store.create(
      route.sessionKey,
      route.agentId,
      params.channelId,
      params.peerId,
    );

  // Lifecycle: session_start / session_resume (non-blockable). Fires
  // exactly once per session boundary — new sessions see start, reloads
  // see resume with cached turnsSoFar. Soft-fail via the registry.
  const lifecycleHooks = pipeline.getLifecycleHooks?.();
  if (lifecycleHooks) {
    if (isNewSession) {
      await lifecycleHooks.fire("session_start", {
        sessionId: session.sessionKey,
        agentId: route.agentId,
        channelId: params.channelId,
        peerId: params.peerId,
      });
    } else {
      await lifecycleHooks.fire("session_resume", {
        sessionId: session.sessionKey,
        agentId: route.agentId,
        turnsSoFar: session.transcript.length,
        lastActivity: new Date().toISOString(),
      });
    }
  }

  // Ack the request immediately — streaming events follow
  ws.send(
    JSON.stringify(
      makeResponse(frameId, {
        status: "streaming",
        sessionKey: route.sessionKey,
      }),
    ),
  );

  logger.info(
    { sessionKey: route.sessionKey, agentId: route.agentId },
    "Processing chat message",
  );

  // 3. Normalize input — detect obfuscation (Base64, ROT13, leetspeak, homoglyphs, invisible chars)
  const normResult = normalizeInput(content);

  // 4. Arbiter: deterministic intent gate. Replaces the old Layer 0
  //    pattern-matching dispatcher. Structured tool intents
  //    ("write me a story to story.txt") run through the
  //    extractIntent → consult → execute pipeline; everything else
  //    falls through to inference. The LLM never sees this logic.
  const sink = createWebSocketSink(ws);
  const agentConfig = config.agents.find((a) => a.id === route.agentId) ?? config.agents[0]!;

  const arbiterOutcome = await runArbiterTurn({
    content: normResult.normalized,
    providerFn: pipeline.getArbiterProviderFn(agentConfig.id),
    sink,
    session,
    store,
    sessionKey: route.sessionKey,
    workspace: getWorkspaceRoot(),
  });

  if (arbiterOutcome.handled) {
    logger.info(
      { sessionKey: route.sessionKey, reason: arbiterOutcome.reason },
      "Arbiter handled request — skipping inference",
    );
    return;
  }

  // Layer 2 was historically gated on Layer 0's bestConfidence band
  // (0.5–0.69). Without Layer 0, we surface a fixed mid-band signal
  // so Layer 2's existing gate keeps firing for users who have it on,
  // and stays inert for users who don't (default disabled).
  const layer0BestConfidence = 0.55;

  // 4b. Layer 2: local model disambiguation
  //     Routes medium-confidence requests (0.5–0.69 band) to a local model.
  //     All enforcement is code-level — the LLM never sees this logic.
  const layer2Config = config.layer2 as Layer2Config;
  const layer2Enabled = session.layer2Override?.enabled ?? layer2Config.enabled;

  if (layer2Enabled && layer2Config.providerId) {
    const layer2Provider = pipeline.getProvider(layer2Config.providerId);

    if (
      layer2Provider &&
      layer0BestConfidence >= layer2Config.confidenceThreshold &&
      layer0BestConfidence <= layer2Config.confidenceCeiling
    ) {
      const layer2Result = await handleLayer2(normResult.normalized, {
        config: layer2Config,
        provider: layer2Provider,
        sink,
        session,
        sessionKey: route.sessionKey,
        store,
        auditLog: pipeline.auditLog,
        layer0Confidence: layer0BestConfidence,
      });

      if (layer2Result.handled) {
        logger.info(
          { sessionKey: route.sessionKey, reason: layer2Result.reason },
          "Layer 2 handled request — skipping inference",
        );
        return;
      }

      logger.debug(
        {
          sessionKey: route.sessionKey,
          reason: layer2Result.reason,
          escalated: layer2Result.escalated,
        },
        "Layer 2 pass-through — escalating to inference",
      );
    }
  }

  // 5. Run inference pipeline (Layer 3 — streams tokens back via ConnectorSink)
  await pipeline.handleTurn(sink, session, normResult.normalized, store, normResult.detections);
}

async function handleChatHistory(
  ws: WebSocket,
  frameId: string,
  params: { channelId?: string; peerId?: string; limit: number },
  config: Config,
  store: SessionStore,
  ownedSessions: Set<string>,
): Promise<void> {
  const route = resolveRoute(
    { channelId: params.channelId, peerId: params.peerId },
    config.routing,
  );

  // Session ownership check: only allow history for sessions this client has accessed
  if (!ownedSessions.has(route.sessionKey)) {
    ws.send(
      JSON.stringify(
        makeErrorResponse(frameId, "SESSION_ACCESS_DENIED", "Not authorized to access this session"),
      ),
    );
    return;
  }

  const session = await store.load(route.sessionKey);
  if (!session) {
    ws.send(JSON.stringify(makeResponse(frameId, { entries: [] })));
    return;
  }

  const entries = trimTranscript(session.transcript, params.limit);
  ws.send(JSON.stringify(makeResponse(frameId, { entries })));
}

async function handleCommandExec(
  ws: WebSocket,
  frameId: string,
  params: { name: string; args: string; channelId?: string; peerId?: string },
  config: Config,
  pipeline: InferencePipeline,
  store: SessionStore,
  circuitBreaker?: CircuitBreaker,
): Promise<void> {
  const cmd = getCommand(params.name);
  if (!cmd) {
    ws.send(
      JSON.stringify(makeErrorResponse(frameId, "UNKNOWN_COMMAND", `Unknown command: /${params.name}`)),
    );
    return;
  }

  const route = resolveRoute(
    { channelId: params.channelId, peerId: params.peerId },
    config.routing,
  );

  const sink = createWebSocketSink(ws);
  const ctx: CommandContext = {
    sink,
    sessionKey: route.sessionKey,
    frameId,
    config,
    store,
    pipeline,
    circuitBreaker,
    args: params.args,
  };

  ws.send(JSON.stringify(makeCommandRecognizedEvent(params.name, frameId)));
  ws.send(JSON.stringify(makeResponse(frameId, { status: "streaming", sessionKey: "__command" })));
  const result = await cmd.handler(ctx);
  ws.send(JSON.stringify(makeTokenEvent(result.output, "__command")));
  ws.send(JSON.stringify(makeDoneEvent("__command", frameId)));
}
