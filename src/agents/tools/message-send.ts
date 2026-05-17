/**
 * message_send — agent-driven outbound messaging to external channels.
 *
 * This is the tool the agent calls when it wants to reach the user on
 * a surface other than the CLI console they're currently running —
 * Discord, Telegram, email, etc. Every external send is:
 *
 *   1. Validated (content length, channel count, allowlist).
 *   2. Tagged with a single-use kill token — the kill link is
 *      appended to the delivered content so the user always has an
 *      out-of-band stop button, no matter which channel they read it
 *      on. This is the hard invariant: no external send without a
 *      kill link, ever.
 *   3. Dispatched via the outbound connector registry.
 *   4. Mirrored to the CLI via the mirror broker so the console
 *      transcript remains the single source of truth.
 *   5. Returned as a structured tool result so the agent sees
 *      delivery outcomes on the next turn.
 *
 * Stage (a) of the message_send trilogy ships the core: the tool, the
 * kill-link invariant, the mirror. The registry starts empty, so the
 * tool errors gracefully when the agent names a channel that no
 * connector is registered for. Stages (b) and (c) will add the
 * Discord webhook and Telegram bot connectors respectively.
 */

import { randomUUID } from "node:crypto";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import type { ToolExecutionContext } from "./types.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getOutboundConnector,
  listOutboundConnectors,
  type OutboundConnector,
} from "../../connectors/outbound.js";
import { issueKillToken } from "../../security/kill-tokens.js";
import {
  emitOutboundMirror,
  type OutboundMirrorEvent,
} from "./message-mirror-broker.js";

export const MAX_MESSAGE_CONTENT_LEN = 4_000;
export const MIN_MESSAGE_CONTENT_LEN = 1;
export const MAX_CHANNELS_PER_CALL = 4;
export const MAX_REASON_LEN = 200;
export const KILL_URL_PATH = "/admin/kill-token";

// ── Configuration ────────────────────────────────────────

let killUrlBase = "";

/**
 * Set the public base URL used to construct kill links embedded in
 * outbound messages. Called from registerBuiltinTools at startup.
 *
 * An empty string disables kill-link construction (tests, or local-
 * only setups without external connectors). In that case message_send
 * still validates, mirrors to CLI, and dispatches, but the URL field
 * on the delivery payload will be empty.
 */
export function setKillUrlBase(base: string): void {
  if (typeof base !== "string") {
    killUrlBase = "";
    return;
  }
  // Strip trailing slash for consistent joining.
  killUrlBase = base.replace(/\/+$/, "");
}

export function _getKillUrlBase(): string {
  return killUrlBase;
}

// ── Per-session rate limiting ────────────────────────────

const SEND_WINDOW_MS = 60_000;
const SEND_MAX_PER_WINDOW = 10;

interface RateEntry {
  windowStart: number;
  count: number;
}

const rateState: Map<string, RateEntry> = new Map();

function checkRate(sessionKey: string): { ok: boolean; retryMs?: number } {
  const now = Date.now();
  const entry = rateState.get(sessionKey);
  if (!entry || now - entry.windowStart >= SEND_WINDOW_MS) {
    rateState.set(sessionKey, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (entry.count >= SEND_MAX_PER_WINDOW) {
    return { ok: false, retryMs: SEND_WINDOW_MS - (now - entry.windowStart) };
  }
  entry.count += 1;
  return { ok: true };
}

/** For tests — clear rate-limit state. */
export function _resetMessageSendRate(): void {
  rateState.clear();
}

// ── Tool handler ─────────────────────────────────────────

interface PerChannelResult {
  channel: string;
  delivered: boolean;
  error?: string;
  deliveryId?: string;
}

function buildKillUrl(token: string): string {
  if (!killUrlBase || !token) return "";
  return `${killUrlBase}${KILL_URL_PATH}?t=${token}`;
}

function formatResult(
  results: PerChannelResult[],
  killUrl: string,
  reason: string,
): string {
  const lines = results.map((r) => {
    if (r.delivered) {
      return `  ✓ ${r.channel}${r.deliveryId ? ` (id=${r.deliveryId})` : ""}`;
    }
    return `  ✗ ${r.channel}: ${r.error ?? "unknown error"}`;
  });
  const ok = results.filter((r) => r.delivered).length;
  const total = results.length;
  const header = `message_send: ${ok}/${total} delivered${reason ? ` — ${reason}` : ""}`;
  const killLine = killUrl
    ? `\nkill link (single-use, 1h): ${killUrl}`
    : "";
  return `${header}\n${lines.join("\n")}${killLine}`;
}

async function handleMessageSend(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ content: string; isError?: boolean; outputs?: Record<string, unknown> }> {
  if (!context?.sessionKey) {
    return {
      content: "message_send is only available inside an active user session.",
      isError: true,
    };
  }
  const sessionKey = context.sessionKey;

  // --- validate content ------------------------------------------------
  const content =
    typeof params.content === "string" ? params.content.trim() : "";
  if (content.length < MIN_MESSAGE_CONTENT_LEN) {
    return {
      content: "message_send: 'content' is required and must be non-empty.",
      isError: true,
    };
  }
  if (content.length > MAX_MESSAGE_CONTENT_LEN) {
    return {
      content: `message_send: content too long (${content.length} > ${MAX_MESSAGE_CONTENT_LEN}).`,
      isError: true,
    };
  }

  // --- validate channels -----------------------------------------------
  if (!Array.isArray(params.channels)) {
    return {
      content:
        "message_send: 'channels' must be an array of connector ids (e.g. [\"discord\"]).",
      isError: true,
    };
  }
  const rawChannels = params.channels;
  if (rawChannels.length === 0) {
    return {
      content: "message_send: 'channels' must contain at least one entry.",
      isError: true,
    };
  }
  if (rawChannels.length > MAX_CHANNELS_PER_CALL) {
    return {
      content: `message_send: too many channels (${rawChannels.length} > ${MAX_CHANNELS_PER_CALL}).`,
      isError: true,
    };
  }
  const channels: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawChannels.length; i++) {
    const c = rawChannels[i];
    if (typeof c !== "string" || c.length === 0) {
      return {
        content: `message_send: channel ${i} must be a non-empty string.`,
        isError: true,
      };
    }
    if (seen.has(c)) {
      return {
        content: `message_send: duplicate channel '${c}'.`,
        isError: true,
      };
    }
    seen.add(c);
    channels.push(c);
  }

  // --- validate reason -------------------------------------------------
  let reason = "";
  if (params.reason !== undefined) {
    if (typeof params.reason !== "string") {
      return {
        content: "message_send: 'reason' must be a string.",
        isError: true,
      };
    }
    reason = params.reason.trim().slice(0, MAX_REASON_LEN);
  }

  // --- rate limit ------------------------------------------------------
  const rate = checkRate(sessionKey);
  if (!rate.ok) {
    return {
      content: `message_send: rate-limited — try again in ${Math.ceil((rate.retryMs ?? SEND_WINDOW_MS) / 1000)}s (max ${SEND_MAX_PER_WINDOW} sends/min).`,
      isError: true,
    };
  }

  // --- resolve connectors up front; bail before side effects if any
  //     channel is unknown ---------------------------------------------
  const resolved: { id: string; connector: OutboundConnector }[] = [];
  const missing: string[] = [];
  for (const id of channels) {
    const c = getOutboundConnector(id);
    if (!c) {
      missing.push(id);
    } else {
      resolved.push({ id, connector: c });
    }
  }
  if (missing.length > 0) {
    const available = listOutboundConnectors()
      .map((c) => c.id)
      .join(", ");
    return {
      content:
        `message_send: no outbound connector registered for [${missing.join(", ")}]. ` +
        `Available: ${available || "(none)"}.`,
      isError: true,
    };
  }

  // --- issue one kill token for the whole dispatch --------------------
  const token = issueKillToken(sessionKey, reason || "message_send");
  const killUrl = buildKillUrl(token);

  // --- deliver to each channel ----------------------------------------
  const results: PerChannelResult[] = [];
  for (const { id, connector } of resolved) {
    const timestamp = new Date().toISOString();
    const messageId = randomUUID();
    try {
      const result = await connector.deliver({
        sessionKey,
        content,
        killUrl,
        reason,
      });
      results.push({
        channel: id,
        delivered: result.ok,
        error: result.ok ? undefined : (result.error ?? "delivery failed"),
        deliveryId: result.deliveryId,
      });

      const mirror: OutboundMirrorEvent = {
        sessionKey,
        messageId,
        channel: id,
        content,
        delivered: result.ok,
        error: result.ok ? undefined : (result.error ?? "delivery failed"),
        killUrl,
        timestamp,
      };
      emitOutboundMirror(mirror);
    } catch (err: unknown) {
      const msg = formatErrorMessage(err);
      logger.warn(
        { err, channel: id, sessionKey },
        "Outbound connector threw during deliver()",
      );
      results.push({ channel: id, delivered: false, error: msg });
      emitOutboundMirror({
        sessionKey,
        messageId,
        channel: id,
        content,
        delivered: false,
        error: msg,
        killUrl,
        timestamp,
      });
    }
  }

  const anyDelivered = results.some((r) => r.delivered);
  const delivered = results.filter((r) => r.delivered).map((r) => r.channel);
  const failed = results
    .filter((r) => !r.delivered)
    .map((r) => ({ channel: r.channel, error: r.error ?? "unknown error" }));
  return {
    content: formatResult(results, killUrl, reason),
    isError: !anyDelivered,
    outputs: {
      delivered,
      failed,
      total: results.length,
      kill_url: killUrl,
    },
  };
}

export function registerMessageSendTool(): void {
  registerToolHandler("message_send", handleMessageSend);
  registerPromptFragment({
    id: "tool:message_send",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("message_send"),
    order: 10,
    content: [
      "REMOTE DELIVERY: If the user signals they are going away — phrases like",
      '"I\'m heading out", "ping me when done", "shoot me a message", "let me',
      'know", "message me on discord", "I\'ll be back later" — you MUST plan to',
      "call message_send as the final step of your task. Do NOT just post your",
      "summary to the chat window and stop; the user isn't watching it. Call",
      'message_send with channels=["discord"] (or whichever channel they named),',
      "a short summary (1-3 lines), and if relevant the filename or location of",
      "what you produced. Treat the user's stated absence as already confirmed —",
      'you do not need to ask "where should I send it?" if they have told you',
      'where. If they only said "ping me" without naming a channel, use the',
      "first available connector (usually discord) and mention which channel in",
      "your summary.",
    ].join("\n"),
  });
  logger.info({ tools: ["message_send"] }, "message_send tool registered");
}
