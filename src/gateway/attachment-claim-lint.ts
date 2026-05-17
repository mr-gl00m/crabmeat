/**
 * Post-turn lint: catch the case where an outbound reply narrates an
 * attachment that was never actually staged for delivery.
 *
 * Motivation: the 2026-04-24 "AI_Cybersecurity_Report_2026.md" incident —
 * three tool calls in one turn (file_copy, email_attach, message_send) all
 * returned status="error", and the model's final reply still contained
 * "Attached AI_Cybersecurity_Report_2026.md — compiled research…". The
 * tool layer did everything right (errors were stamped). The capability-
 * wall test already protects that. Prompt-layer rules ("don't narrate
 * success for errored calls") are a belt-and-suspenders fix but are not
 * reliable on smaller models — they skim the prompt.
 *
 * This module is the code-level backstop. It runs deterministically at the
 * send seam, after the inference loop has returned a body and the
 * attachment queue has been drained. If the body claims an attachment and
 * the drained queue is empty, we append a factual correction notice so the
 * user is not lied to. We never silently rewrite or drop the model's text
 * above the notice — the reader can still see what the model actually said.
 *
 * This is model-independent: it works the same against Gemma, Claude,
 * GPT, a stubbed provider in tests, whatever. That is the point.
 */

/**
 * Narrow patterns aimed at first-person "I attached X" style claims and
 * obvious attachment-reference phrases ("see attached", "attached below").
 * Deliberately conservative: we'd rather miss a weird phrasing than append
 * the notice on a turn where no attachment was ever claimed. False
 * positives are worse than false negatives here because they inject a
 * system notice into a legitimate reply.
 */
const CLAIM_PATTERNS: RegExp[] = [
  // "I attached X", "I've attached X", "I have attached X", "I'm attaching X",
  // "I will attach X", "I'll attach X", also plain "I attach X".
  // The subject is "I" — passive mentions like "the topic attached to…" miss.
  /\bI(?:['’]ve|['’]ll| have| will| am|['’]m)?\s+(?:attached|attaching|attach)\b/i,

  // "Attached: foo.md", "attached foo.md", "I've attached foo.pdf" — verb
  // directly adjacent to a filename-like token (dot + 1–6 char ext).
  /\battached\s+\S{0,40}?\.[a-z0-9]{1,6}\b/i,

  // "see attached", "see the attachment" — common sign-off phrasing.
  /\bsee\s+(?:the\s+)?(?:attached|attachment)\b/i,

  // "attached below/above/to this email/to this reply/with this message"
  /\b(?:attached|attachment)s?\s+(?:below|above|with\s+(?:this|my)\s+(?:reply|message|email)|to\s+this\s+(?:email|reply|message))\b/i,

  // "the attached file/report/document/pdf/etc" — noun-form reference.
  /\bthe\s+attached\s+(?:file|report|document|pdf|csv|markdown|transcript|spreadsheet|script|image)\b/i,
];

/**
 * Negation guard — if one of these words appears within ~30 characters
 * before a matched claim, treat the match as negated and don't fire.
 * Covers the "Nothing was attached to this reply" / "the file was not
 * attached" case where a model honestly reports failure using attachment
 * vocabulary. Narrow window so we don't suppress real claims that
 * happen to have "not" two sentences back.
 */
const NEGATION_NEAR = /\b(?:no|not|nothing|none|never|wasn['’]?t|weren['’]?t|isn['’]?t|aren['’]?t|without|couldn['’]?t|could\s*not|failed\s+to|unable\s+to)\b[^.]{0,30}$/i;

/**
 * True if `body` contains text that reads as a claim of an attachment on
 * the current reply. Narrow by design, with a negation guard so honest
 * failure reports don't trip the detector.
 */
export function detectAttachmentClaim(body: string): boolean {
  if (!body) return false;
  return firstClaimMatch(body) !== null;
}

/**
 * Find the first claim-pattern match that isn't defused by nearby
 * negation. Returns the matching pattern (for logging) or null.
 */
function firstClaimMatch(body: string): RegExp | null {
  for (const p of CLAIM_PATTERNS) {
    const m = p.exec(body);
    if (!m) continue;
    const before = body.slice(Math.max(0, m.index - 40), m.index);
    if (NEGATION_NEAR.test(before)) continue;
    return p;
  }
  return null;
}

export const ATTACHMENT_FABRICATION_NOTICE =
  "\n\n---\n" +
  "[crabmeat notice] The message above mentions an attachment, but no " +
  "file was actually staged for delivery with this reply — the attachment " +
  "flow either failed or was never invoked. This notice was appended " +
  "automatically so you are not left relying on a file that does not exist.";

export interface LintResult {
  body: string;
  intercepted: boolean;
  /** Short phrase naming which claim pattern fired, for logs. Empty if none. */
  reason: string;
}

/**
 * Decide whether to append the fabrication notice to an outbound reply.
 *
 * - If attachments were actually staged, do nothing (claim is true).
 * - If no claim language is present, do nothing (nothing to correct).
 * - Otherwise append the notice and report the intercept.
 */
export function appendFabricationNoticeIfNeeded(
  body: string,
  attachmentCount: number,
): LintResult {
  if (attachmentCount > 0) {
    return { body, intercepted: false, reason: "" };
  }
  const matched = firstClaimMatch(body);
  if (matched) {
    return {
      body: body + ATTACHMENT_FABRICATION_NOTICE,
      intercepted: true,
      reason: matched.source,
    };
  }
  return { body, intercepted: false, reason: "" };
}
