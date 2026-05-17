/**
 * Layer 2 Escalation Detection
 *
 * Analyzes the local model's response to determine whether it can
 * confidently handle the request or should escalate to Layer 3.
 *
 * Escalation signals:
 * - Configured marker phrases (hedging, uncertainty)
 * - Empty or near-empty responses (model confusion)
 * - Parrot responses (model echoing input without adding value)
 */

import type { EscalationResult } from "./types.js";

/** Minimum response length to be considered a real answer. */
const MIN_RESPONSE_LENGTH = 5;

/**
 * Detect whether the local model's response indicates it cannot
 * handle the request and should escalate to Layer 3.
 */
export function detectEscalation(
  responseText: string,
  markers: string[],
): EscalationResult {
  const trimmed = responseText.trim();

  // Empty or near-empty response — model produced nothing useful
  if (trimmed.length < MIN_RESPONSE_LENGTH) {
    return { shouldEscalate: true, matchedMarker: "__empty_response" };
  }

  // Check configured escalation markers (case-insensitive)
  const lower = trimmed.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker.toLowerCase())) {
      return { shouldEscalate: true, matchedMarker: marker };
    }
  }

  return { shouldEscalate: false };
}

/**
 * Streaming lead-buffer for escalation detection.
 *
 * Mirrors RefusalLeadBuffer (agents/refusal-detect.ts). Holds the first
 * `leadBytes` chars of the local model's stream before committing to
 * the sink. If the lead contains an escalation marker, the buffered
 * content is swallowed and the caller falls through to Layer 3 — so
 * the user never sees "I'm not sure..." stutter into a Layer 3 retry.
 *
 * Two states: BUFFERING (collecting lead, nothing forwarded) and
 * DECIDED (passthrough on clean, swallow on escalation). Auto-transitions
 * when the lead fills; callers force the decision via decide() on
 * stream-end-before-fill (short response).
 *
 * Tradeoff: a marker that appears AFTER the lead window ships through
 * to the user. Catching late hedges would re-introduce the
 * stream-then-replay UX the buffer was added to remove.
 */
export class EscalationLeadBuffer {
  private lead = "";
  private decided = false;
  private match: string | null = null;

  constructor(
    private readonly markers: readonly string[],
    private readonly leadBytes: number = 200,
  ) {}

  /**
   * Feed a streamed chunk. Returns text to forward to the sink now —
   * empty while collecting the lead, the buffered lead on first commit,
   * the chunk itself once decided-clean, and empty on escalation.
   */
  feed(chunk: string): string {
    if (this.decided) {
      return this.match === null ? chunk : "";
    }

    this.lead += chunk;
    if (this.lead.length < this.leadBytes) {
      return "";
    }

    // decide() clears this.lead on clean, so capture the returned lead
    // before it's gone.
    const { matchedMarker, lead } = this.decide();
    if (matchedMarker !== null) {
      return "";
    }
    return lead;
  }

  /**
   * Force a decision using whatever is currently buffered. Idempotent.
   * Use this on stream-end when the lead never filled (short response).
   */
  decide(): { matchedMarker: string | null; lead: string } {
    if (!this.decided) {
      const result = detectEscalation(this.lead, [...this.markers]);
      this.match =
        result.shouldEscalate ? (result.matchedMarker ?? "__unknown") : null;
      this.decided = true;
    }
    const lead = this.lead;
    if (this.match === null) {
      this.lead = "";
    }
    return { matchedMarker: this.match, lead };
  }

  get isDecided(): boolean {
    return this.decided;
  }

  get didDetectEscalation(): boolean {
    return this.decided && this.match !== null;
  }

  get matchedMarker(): string | null {
    return this.match;
  }
}
