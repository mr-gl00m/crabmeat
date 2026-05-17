/**
 * Layer 2 Router — Local Model Disambiguation
 *
 * Routes medium-confidence requests to a local model (typically Ollama)
 * for disambiguation, confirmation prompts, or simple reasoning.
 *
 * Security model:
 * - Disabled by default — user opts in via config
 * - No tool access — Layer 2 only generates text responses
 * - System prompt is code-level, not influenced by conversation
 * - Graceful degradation — falls through to Layer 3 on any failure
 * - All routing decisions are audit-logged
 */

import { randomUUID } from "node:crypto";
import { logger } from "../../infra/logger.js";
import { createTranscriptEntry } from "../../sessions/transcript.js";
import type { ChatMessage, StreamEvent } from "../providers/types.js";
import type { Layer2Result, Layer2Context } from "./types.js";
import { checkLayer2Health } from "./health.js";
import { EscalationLeadBuffer } from "./escalation.js";

// ── Main dispatch ────────────────────────────────────────

/**
 * Attempt to handle a user message at Layer 2 (local model).
 *
 * Returns a Layer2Result indicating whether the message was handled.
 * If handled, the response has already been sent via the sink.
 * If not handled, the caller should fall through to Layer 3.
 */
export async function handleLayer2(
  userContent: string,
  ctx: Layer2Context,
): Promise<Layer2Result> {
  const { config, provider, sink, session, sessionKey } = ctx;
  const startTime = Date.now();

  // ── Gate: disabled ───────────────────────────────────
  if (!config.enabled) {
    return { handled: false, escalated: false, reason: "Layer 2 disabled" };
  }

  // ── Gate: health check ───────────────────────────────
  const isHealthy = await checkLayer2Health(provider, config.healthCheckTimeoutMs);
  if (!isHealthy) {
    recordAudit(ctx, startTime, false, false, "Layer 2 provider unhealthy");
    return {
      handled: false,
      escalated: false,
      reason: "Layer 2 provider unhealthy — falling through to Layer 3",
      layer0Confidence: ctx.layer0Confidence,
    };
  }

  // ── Build minimal context ────────────────────────────
  // System prompt + last few turns for conversational context + current message.
  // Keep it lean — local models have small context windows.
  const messages = buildLayer2Messages(config.systemPrompt, session, userContent);

  // ── Stream from local model ──────────────────────────
  // Stream tokens to the client as they arrive — but hold the lead in
  // an EscalationLeadBuffer first. If the local model opens with a
  // hedge ("I'm not sure...", "I need more context"), the buffer
  // catches it before the user sees the stutter and we fall through to
  // Layer 3 with no tokens emitted. Once the lead is decided clean, we
  // commit to passthrough; markers appearing later in the response
  // ship through to the user (catching them would re-introduce the
  // stream-then-replay UX this buffer exists to remove).
  let responseText = "";
  let streamError: Error | null = null;
  let firstTokenSent = false;
  const badgePrefix = config.showLayerBadge ? "[L2] " : "";
  const leadBuffer = new EscalationLeadBuffer(config.escalationMarkers);

  function forwardToSink(text: string): void {
    if (text.length === 0) return;
    if (!firstTokenSent && badgePrefix) {
      sink.sendToken(badgePrefix + text, sessionKey);
    } else {
      sink.sendToken(text, sessionKey);
    }
    firstTokenSent = true;
  }

  try {
    await provider.stream(
      {
        messages,
        model: "", // Provider uses its configured model
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        // No tools — Layer 2 is text-only
      },
      (event: StreamEvent) => {
        switch (event.type) {
          case "token":
            responseText += event.text;
            forwardToSink(leadBuffer.feed(event.text));
            break;
          case "error":
            streamError = event.error;
            break;
          case "done":
            break;
        }
      },
    );
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Handle stream errors gracefully ──────────────────
  if (streamError || !responseText.trim()) {
    const reason = streamError
      ? `Layer 2 stream error: ${streamError.message}`
      : "Layer 2 produced empty response";

    logger.warn(
      { sessionKey, error: streamError?.message },
      reason,
    );
    recordAudit(ctx, startTime, false, false, reason);
    return {
      handled: false,
      escalated: false,
      reason: `${reason} — falling through to Layer 3`,
      layer0Confidence: ctx.layer0Confidence,
    };
  }

  // ── Lead-buffer decision ─────────────────────────────
  // If the stream ended before the lead filled, force the decision now.
  // On clean-and-short, this returns the buffered lead so we can commit
  // it to the sink (otherwise the short response would never be sent).
  // On escalation, the lead stays unforwarded and we fall through.
  const { matchedMarker, lead: tailLead } = leadBuffer.decide();
  if (matchedMarker === null) {
    forwardToSink(tailLead);
  }

  if (matchedMarker !== null) {
    logger.info(
      { sessionKey, marker: matchedMarker, layer0Confidence: ctx.layer0Confidence },
      "Layer 2: local model signaled escalation in lead — forwarding to Layer 3",
    );
    recordAudit(ctx, startTime, false, true, `Escalation marker: ${matchedMarker}`);
    return {
      handled: false,
      escalated: true,
      reason: `Local model hedged (${matchedMarker}) — escalating to Layer 3`,
      layer0Confidence: ctx.layer0Confidence,
      responseText,
    };
  }

  // ── Finalize ─────────────────────────────────────────
  const finalText = (badgePrefix + responseText).trim();
  const messageId = randomUUID();
  sink.sendDone(sessionKey, messageId);

  // Update transcript and persist — fire-and-forget so the client
  // isn't blocked waiting on disk I/O after already receiving the response.
  session.transcript.push(
    createTranscriptEntry("user", userContent, { source: "user_input" }),
    createTranscriptEntry("assistant", finalText, { source: "assistant" }),
  );
  ctx.store.save(session).catch((err) => {
    logger.warn({ sessionKey, error: (err as Error).message }, "Layer 2: session save failed (non-fatal)");
  });

  // Audit — synchronous in-memory, no I/O
  recordAudit(ctx, startTime, true, false, `Layer 2 handled (confidence: ${ctx.layer0Confidence.toFixed(2)})`);

  return {
    handled: true,
    escalated: false,
    reason: `Handled by local model (confidence: ${ctx.layer0Confidence.toFixed(2)})`,
    layer0Confidence: ctx.layer0Confidence,
    responseText: finalText,
  };
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Build a minimal message array for the local model.
 * Includes: system prompt, last 3 transcript entries (for context),
 * and the current user message.
 */
function buildLayer2Messages(
  systemPrompt: string,
  session: { transcript: Array<{ role: string; content: string }> },
  userContent: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Include recent transcript for conversational context (up to 3 entries)
  const recent = session.transcript.slice(-3);
  for (const entry of recent) {
    if (entry.role === "user" || entry.role === "assistant") {
      messages.push({ role: entry.role as "user" | "assistant", content: entry.content });
    }
  }

  // Current user message
  messages.push({ role: "user", content: userContent });

  return messages;
}

function recordAudit(
  ctx: Layer2Context,
  startTime: number,
  handled: boolean,
  escalated: boolean,
  reason: string,
): void {
  ctx.auditLog.record({
    timestamp: new Date().toISOString(),
    sessionKey: ctx.sessionKey,
    toolId: "__layer2_routing",
    toolName: "layer2_disambiguation",
    effectClass: "read",
    callId: randomUUID(),
    parameters: {
      layer0Confidence: ctx.layer0Confidence,
      handled,
      escalated,
      reason,
    },
    resultStatus: handled ? "success" : escalated ? "denied" : "error",
    durationMs: Date.now() - startTime,
  });
}
