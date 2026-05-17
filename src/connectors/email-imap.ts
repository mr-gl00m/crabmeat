/**
 * email-imap — bidirectional email connector using IMAP for inbound
 * and SMTP for outbound replies.
 *
 * Designed for a dedicated Gmail account using an App Password (Google
 * blocks plain-password IMAP since 2022, and passkeys don't work for
 * IMAP either — App Passwords are the only viable option).
 *
 * Lifecycle:
 *   start(handler) → connect IMAP, open INBOX, schedule polling tick.
 *     Each tick: search for unseen messages, parse each, validate
 *     sender against allowFromAddresses, run the handler, send the
 *     reply via SMTP (threaded with In-Reply-To/References), then
 *     mark the source message \\Seen so it won't be reprocessed.
 *   stop() → cancel the timer, logout IMAP, close SMTP transport.
 *
 * Security:
 *   - allowFromAddresses is the only way mail reaches the agent. A
 *     message from any other address is marked \\Seen and dropped.
 *     There is no "open" mode — empty whitelist is rejected at config
 *     parse time.
 *   - The connector treats body content as untrusted user input and
 *     hands it to the pipeline unchanged. Sigil/canary detection
 *     downstream catches injection attempts.
 *   - Replies use a hardcoded text/plain content type. We don't render
 *     HTML or honor reply-to spoofing.
 *   - Subject lines and sender names are NOT used in the reply unless
 *     they came from a whitelisted address.
 *
 * Errors:
 *   - Per-tick failures (one bad message) are logged and skipped — the
 *     poll loop keeps running.
 *   - Connection-level failures bubble up so the gateway sees them and
 *     can decide whether to restart.
 */

import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { simpleParser } from "mailparser";
import { createHash, randomUUID } from "node:crypto";

import {
  renderEmailReply,
  extractSubjectAndStrip,
  degradeLongResponse,
  truncateSubject,
} from "./email-render.js";
import {
  registerOutboundConnector,
  unregisterOutboundConnector,
} from "./outbound.js";
import { logger } from "../infra/logger.js";
import { registerPromptFragment } from "../agents/prompt-fragments.js";
import { formatErrorMessage } from "../infra/errors.js";
import { recordConnectorFailure } from "./status.js";
import { diagnostics } from "../infra/diagnostics/index.js";
import type {
  InboundConnector,
  InboundHandler,
  InboundMessage,
} from "./inbound.js";
import type { EmailImapConnectorConfig } from "../config/types.js";
import type { AuditLog } from "../security/audit.js";

export interface EmailImapConnectorOptions extends EmailImapConnectorConfig {
  /** Override the IMAP client constructor for tests. */
  imapFactory?: typeof ImapFlow;
  /** Override the SMTP transport factory for tests. */
  smtpFactory?: typeof nodemailer.createTransport;
  /**
   * Audit log for per-attachment send entries. When provided, every
   * attachment that successfully leaves the box gets one chain entry
   * with filename, size, SHA-256 hash, and recipient. Absence is fine
   * for tests — the connector still delivers, just without the audit
   * trail. Phase 4.4.7.
   */
  auditLog?: AuditLog;
}

/**
 * Maximum number of unseen messages handled per poll tick. A flood (mass
 * forward, list misconfig, compromised allowlisted sender) would otherwise
 * run the full inference loop sequentially for every message and stall the
 * connector — back-pressure-by-cap is safer than letting the queue drain
 * unbounded. Overflow is logged at WARN and rolls into the next tick.
 */
const MAX_MESSAGES_PER_TICK = 5;

/**
 * Parse `Authentication-Results` (RFC 8601) from a mailparser headers
 * map. Returns the SPF/DKIM/DMARC verdicts and a `failed` flag set when
 * any verdict is `fail` — that's the upstream MTA telling us the From:
 * header is a likely spoof. Allowlisted senders that fail this check
 * are dropped before reaching the agent. RT-2026-04-30-003.
 *
 * `softfail`, `temperror`, `permerror`, `none`, and `neutral` do NOT
 * mark the message as failed — those are the gray zone where the
 * upstream MTA is unsure or the sender is unverifiable, which is the
 * common case for forwarded or list-server mail. Only `fail` is hard.
 */
export interface AuthVerdicts {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  failed: boolean;
  verdicts: Record<string, string>;
}

export function parseAuthenticationResults(
  headers: ReadonlyMap<string, unknown> | Map<string, unknown> | undefined,
): AuthVerdicts {
  const verdicts: Record<string, string> = {};
  if (!headers) return { failed: false, verdicts };

  // mailparser exposes header values either as a single string or as an
  // array of strings when the header repeats (which Authentication-Results
  // does in multi-hop forwards). Normalize to a string array.
  const raw = headers.get?.("authentication-results");
  const lines: string[] = [];
  if (typeof raw === "string") lines.push(raw);
  else if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === "string") lines.push(v);
  }

  for (const line of lines) {
    // "spf=pass", "dkim=pass header.d=example.com", "dmarc=fail (...)"
    for (const method of ["spf", "dkim", "dmarc"] as const) {
      const re = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, "i");
      const m = re.exec(line);
      if (m && !verdicts[method]) {
        verdicts[method] = m[1]!.toLowerCase();
      }
    }
  }

  const failed =
    verdicts.spf === "fail" ||
    verdicts.dkim === "fail" ||
    verdicts.dmarc === "fail";

  return {
    spf: verdicts.spf,
    dkim: verdicts.dkim,
    dmarc: verdicts.dmarc,
    failed,
    verdicts,
  };
}

/**
 * Pull a normalized email address out of a value imapflow / mailparser
 * may hand back as either a string or an `{address, name}` object, or
 * a list of either. We only need the first address, lowercased and
 * trimmed, for whitelist comparison.
 */
function extractAddress(
  value: unknown,
): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) {
    for (const item of value) {
      const a = extractAddress(item);
      if (a) return a;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.address === "string") return obj.address.trim().toLowerCase();
    if (Array.isArray(obj.value)) return extractAddress(obj.value);
  }
  return undefined;
}

/**
 * Like extractAddress, but walks the whole tree and returns every unique
 * address in order. Used to capture the full To: and Cc: lists so reply-all
 * keeps multi-recipient threads intact — otherwise a thread with three
 * participants silently collapses to a 1:1 on the first agent reply.
 *
 * Dedupes case-insensitively while preserving first-seen order. Empty /
 * unparseable entries are skipped silently (they'd fail downstream anyway).
 */
function extractAllAddresses(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function walk(v: unknown): void {
    if (!v) return;
    if (typeof v === "string") {
      const a = v.trim().toLowerCase();
      if (a && !seen.has(a)) {
        seen.add(a);
        out.push(a);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj.address === "string") {
        const a = obj.address.trim().toLowerCase();
        if (a && !seen.has(a)) {
          seen.add(a);
          out.push(a);
        }
        return;
      }
      if (Array.isArray(obj.value)) walk(obj.value);
    }
  }
  walk(value);
  return out;
}

/**
 * True when the configured agent address appears in the inbound's `To`
 * line — i.e. the agent is a primary recipient, not a CC bystander.
 *
 * If the To line is empty (rare — mailing lists with envelope-only
 * routing, BCC-only sends), the agent could still be the intended
 * recipient and we cannot prove otherwise from headers alone, so we
 * treat it as direct. Better to reply to the rare empty-To case than
 * silently drop a legitimate question.
 */
export function wasAgentInTo(parsedTo: unknown, agentAddress: string): boolean {
  const to = extractAllAddresses(parsedTo);
  if (to.length === 0) return true;
  const agentLower = agentAddress.trim().toLowerCase();
  if (!agentLower) return true;
  return to.includes(agentLower);
}

/**
 * True when the inbound subject or body addresses the agent by name.
 * Three signals folded together:
 *
 *   1. Full email address present anywhere in subject/body
 *      (catches "crabmeat@example.com please weigh in")
 *   2. Local-part as a standalone word — `\b` matches the boundary
 *      between `@` and a word character so this also catches
 *      Slack-style "@local-part" mentions
 *      (catches "Hey Crabmeat, ..." and "@crabmeat heads up")
 *
 * Case-insensitive. Operators on a generic local-part ("info",
 * "contact", "admin") will see false positives — they should set
 * connectors.emailImap.replyOnlyWhenAddressed = false.
 */
export function isAddressedByName(
  subject: string,
  body: string,
  agentAddress: string,
): boolean {
  const haystack = `${subject ?? ""}\n${body ?? ""}`;
  if (!haystack.trim()) return false;
  const agentLower = agentAddress.trim().toLowerCase();
  if (!agentLower) return false;
  if (haystack.toLowerCase().includes(agentLower)) return true;
  const local = agentLower.split("@")[0];
  if (!local || local.length === 0) return false;
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Build RFC 5322 §3.6.4 threading headers (In-Reply-To, References) for
 * an outgoing reply, given the inbound message's headers as parsed by
 * mailparser.
 *
 * Per the RFC:
 *   - In-Reply-To = the parent message's Message-ID
 *   - References  = the parent's References chain + the parent's Message-ID
 *
 * The naive previous behavior (`references: [parent.messageId]` only)
 * worked for two-message threads because Gmail and Apple Mail thread on
 * In-Reply-To alone. It silently broke deeper threads in stricter
 * clients (Outlook, mutt, niche MUAs) and made forwarded threads
 * unrebuildable — once a chain loses its middle links, no client can
 * reassemble it. Carrying the full chain forward fixes both.
 *
 * If the inbound has no Message-ID, threading is impossible — return
 * undefined and the caller should send the reply with no thread headers
 * at all (better than a malformed thread that breaks UIs).
 *
 * mailparser surfaces References as either a string (space-separated
 * IDs, the wire format) OR a string[] (already split). Handle both.
 * IDs that are already in the chain are not re-appended — some buggy
 * MUAs put their own Message-ID into their own References, and we
 * don't want to duplicate it when we add it again as the parent.
 */
function buildThreadHeaders(
  inboundMessageId: string | undefined,
  inboundReferences: string | string[] | undefined,
): { inReplyTo: string; references: string[] } | undefined {
  if (!inboundMessageId) return undefined;

  let refs: string[] = [];
  if (typeof inboundReferences === "string") {
    refs = inboundReferences.split(/\s+/).filter((s) => s.length > 0);
  } else if (Array.isArray(inboundReferences)) {
    refs = inboundReferences.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
  }

  if (!refs.includes(inboundMessageId)) {
    refs.push(inboundMessageId);
  }

  return { inReplyTo: inboundMessageId, references: refs };
}

/**
 * Pick the stable identifier that ties every message in an email
 * conversation together. Used as the suffix on the inbound session key
 * so a thread = a session, instead of "every email from this sender =
 * one giant session" (which leaked unrelated topics into each other).
 *
 * Per RFC 5322 §3.6.4, the FIRST id in References is the original
 * message that started the chain — replies append, so position 0 is
 * stable for the life of the thread. If References is absent (this IS
 * the first message), the inbound's own Message-Id becomes the root.
 *
 * Returns undefined only when the inbound has no Message-Id at all,
 * in which case the caller falls back to a sender-only session key.
 */
export function computeThreadRoot(
  references: string | string[] | undefined,
  messageId: string | undefined,
): string | undefined {
  if (typeof references === "string") {
    const first = references.split(/\s+/).find((s) => s.length > 0);
    if (first) return first;
  } else if (Array.isArray(references)) {
    const first = references.find(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (first) return first;
  }
  return messageId;
}

/**
 * Match a leading reply prefix across major locales.
 *
 * Reply tags travel back tagged with the *recipient's* mail-client
 * locale rather than the sender's — a German Outlook user replying to
 * "Foo" sends back "AW: Foo", not "Re: Foo". Without normalization,
 * our reply path sees "AW: Foo" as a fresh subject and emits "Re: AW:
 * Foo", and the thread accretes localization sediment on every turn.
 *
 * Covered: English (Re), German (AW, Antw — Antwort), Swedish/Danish/
 * Norwegian (SV — Svar), Finnish (VS — Vastaus), Polish/Czech (Odp),
 * Russian (Ответ). Subject prefixes outside this set fall through to
 * the legacy behavior — the reply still goes out, it just doesn't get
 * the de-doubling treatment.
 */
const REPLY_PREFIX_RE = /^\s*(?:re|aw|antw|sv|vs|odp|ответ)\s*:\s*/iu;

/**
 * Match any reply OR forward prefix. Used by the body-promotion path
 * to tell whether a subject already carries a routing tag (so we don't
 * promote "Re: empty body" as the prompt — it's just a routing marker).
 */
const REPLY_OR_FORWARD_PREFIX_RE = /^\s*(?:re|aw|antw|sv|vs|odp|ответ|fwd?|fw)\s*:\s*/iu;

/** True when the subject already starts with a localized reply prefix. */
function hasReplyPrefix(subject: string): boolean {
  return REPLY_PREFIX_RE.test(subject);
}

/** Strip a leading reply or forward prefix; returns the trimmed remainder. */
function stripReplyOrForwardPrefix(subject: string): string {
  return subject.replace(REPLY_OR_FORWARD_PREFIX_RE, "").trim();
}

/**
 * Build the outbound reply subject from an inbound (or agent-emitted)
 * subject. Normalizes localized reply prefixes (AW: / Antw: / SV: / VS:
 * / Odp: / Ответ:) to the English Re: that every mail client groups by.
 *
 * Forward prefixes are NOT stripped here — replying to a forwarded
 * thread should produce "Re: Fwd: foo", since the Fwd: signals
 * provenance the recipient may want to keep.
 */
function buildReplySubject(subject: string): string {
  let s = subject;
  while (REPLY_PREFIX_RE.test(s)) {
    s = s.replace(REPLY_PREFIX_RE, "").trim();
  }
  return `Re: ${s || "(no subject)"}`;
}

/**
 * Decide whether to run the quote-stripper on this inbound's body.
 *
 * For direct replies, stripping is right: every email client piles
 * "On <date>, X wrote:" history onto every reply, and the agent only
 * needs the most recent message.
 *
 * For FORWARDED emails, stripping is wrong: the forwarded section
 * contains a pseudo-header block (From:/Sent:/To:/Subject:) which
 * trips the 3-headers-in-5-lines heuristic in stripQuotedReply and
 * cuts out the very content the agent is supposed to react to. So we
 * skip stripping entirely on forwarded inbounds; trim() keeps the
 * "no leading/trailing whitespace" invariant the strip path provided.
 */
function selectInboundBody(rawBody: string, isForward: boolean): string {
  return isForward ? rawBody.trim() : stripQuotedReply(rawBody);
}

/**
 * Classify the "shape" of an inbound email so the agent can frame its
 * reply appropriately. The connector recognizes three modes:
 *
 *   1. REPLY — direct conversation turn (default; subject typically Re:,
 *      body is a question or response). Quote-history is stripped before
 *      the body reaches the agent.
 *   2. FORWARD — the user is forwarding material for the agent to look
 *      at (subject Fwd: OR body contains an unambiguous forward marker).
 *      Quote-history is preserved so the forwarded content survives, and
 *      a CHANNEL-CONTEXT note tells the agent to react rather than answer.
 *   3. CC / multi-party — the user is one of several recipients (cc list
 *      non-empty). Reply tone shifts to group-thread, reply-all is used
 *      to keep everyone on the chain.
 *
 * The channel-context block produced by buildInboundContext is
 * prepended to the agent's prompt body. The user never sees it — it's
 * part of the prompt envelope, not the reply.
 */
interface InboundShape {
  /**
   * Subject begins with Fwd: / FW: / Fw:, OR the body contains an
   * unambiguous forward marker (Apple Mail "Begin forwarded message:",
   * Gmail/Outlook "----- Forwarded message -----"). The body-marker
   * fallback fixes the case where a user manually edits the Fwd: prefix
   * out of the subject — without it, the body's forwarded-message header
   * trips stripQuotedReply's cut and the agent receives no content to
   * react to. (Phase 4 test bug from project_phase4_test_findings.md.)
   */
  isForward: boolean;
  /** More than one recipient on the thread besides the agent. */
  isMultiParty: boolean;
  /** Total number of non-agent recipients (for diagnostics + prompt). */
  recipientCount: number;
}

/**
 * Unambiguous forward-message markers. Each pattern matches the actual
 * dividing line clients insert between the user's note and the
 * forwarded content — never an "Original Message" line, since Outlook
 * uses that for replies too and we'd over-fire.
 */
const FORWARD_BODY_MARKERS: readonly RegExp[] = [
  // Apple Mail.
  /^\s*Begin forwarded message:\s*$/im,
  // Gmail web/mobile + Outlook variants — dashes around "Forwarded message".
  /^-+\s*Forwarded\s+[Mm]essage\s*-+\s*$/m,
];

/** True when the body contains an unambiguous forwarded-message marker. */
export function bodyLooksForwarded(rawBody: string): boolean {
  if (!rawBody) return false;
  for (const re of FORWARD_BODY_MARKERS) {
    if (re.test(rawBody)) return true;
  }
  return false;
}

function classifyInbound(opts: {
  subject: string;
  ccCount: number;
  /** Optional. When provided, body forward-markers OR with the subject signal. */
  rawBody?: string;
}): InboundShape {
  const subjectLooksForward = /^\s*(?:fwd?|fw)\s*:/i.test(opts.subject);
  const bodyForward = opts.rawBody ? bodyLooksForwarded(opts.rawBody) : false;
  const isForward = subjectLooksForward || bodyForward;
  const isMultiParty = opts.ccCount > 0;
  // ccCount already excludes the sender and the agent, so the total
  // non-agent recipient count is sender(1) + everyone on Cc.
  const recipientCount = 1 + opts.ccCount;
  return { isForward, isMultiParty, recipientCount };
}

/**
 * Summary of an inbound attachment we are about to drop on the floor.
 * Used both for the operator-facing log and for the agent-facing
 * channel-context note. We carry filename + size only — never content,
 * which is the entire point of refusing to process the file.
 */
export interface IgnoredInboundAttachment {
  filename: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * Extract a stable summary of any attachments mailparser found on an
 * inbound message. We don't store, decode, or hand the content to the
 * agent — Phase 4 inbound-attachment handling is deliberately deferred
 * (see memory/project_email_attachments_roadmap.md and Phase 9 in
 * ROADMAP.md). This helper exists so the ignore behavior is explicit
 * and observable instead of silent.
 */
export function extractIgnoredInboundAttachments(
  parsedAttachments: ReadonlyArray<{
    filename?: string;
    contentType?: string;
    size?: number;
    content?: { length?: number };
  }> | undefined,
): IgnoredInboundAttachment[] {
  if (!parsedAttachments || parsedAttachments.length === 0) return [];
  const out: IgnoredInboundAttachment[] = [];
  for (let i = 0; i < parsedAttachments.length; i++) {
    const a = parsedAttachments[i]!;
    const filename = (a.filename && a.filename.trim().length > 0)
      ? a.filename.trim()
      : `attachment_${i + 1}`;
    // mailparser populates either `size` or `content.length`, depending
    // on parsing mode. Take whichever is positive so the agent sees a
    // meaningful number rather than 0.
    const sizeBytes = typeof a.size === "number" && a.size > 0
      ? a.size
      : typeof a.content?.length === "number"
        ? a.content.length
        : 0;
    const contentType = typeof a.contentType === "string" && a.contentType.length > 0
      ? a.contentType
      : undefined;
    const entry: IgnoredInboundAttachment = { filename, sizeBytes };
    if (contentType !== undefined) entry.contentType = contentType;
    out.push(entry);
  }
  return out;
}

function buildInboundContext(
  shape: InboundShape,
  ignoredAttachments: ReadonlyArray<IgnoredInboundAttachment> = [],
): string | undefined {
  const notes: string[] = [];
  if (shape.isForward) {
    notes.push(
      "This is a FORWARDED email. The body below is content the user received elsewhere and is forwarding to you, not a direct question. Read it as material to react to, summarize, extract action items from, or comment on — whichever the user's intent seems to be from any text they added above or below the forwarded content.",
    );
  }
  if (shape.isMultiParty) {
    notes.push(
      `This email was sent to ${shape.recipientCount} recipients (not just you). Your reply will be Cc'd to everyone on the thread — write in a tone appropriate for a multi-party conversation, address the group rather than a single person, and avoid anything you wouldn't want other recipients to see.`,
    );
  }
  if (ignoredAttachments.length > 0) {
    // List up to the first 5 by name+size. Beyond that we just give the
    // count so the line stays readable in a long-attachment send.
    const shown = ignoredAttachments.slice(0, 5);
    const summary = shown
      .map((a) => `${a.filename} (${(a.sizeBytes / 1024).toFixed(1)} KB)`)
      .join(", ");
    const overflow = ignoredAttachments.length > shown.length
      ? ` and ${ignoredAttachments.length - shown.length} more`
      : "";
    notes.push(
      `The user attached ${ignoredAttachments.length} file(s) to this email (${summary}${overflow}). Inbound attachments are NOT currently processed — you cannot see their contents, and refusing to process them is intentional (prompt-injection threat). If your reply depends on what is in those files, ask the user to paste the relevant content into the body or describe what they sent. Do NOT pretend to have read or analyzed the attachments.`,
    );
  }
  if (notes.length === 0) return undefined;
  return (
    "[CHANNEL CONTEXT — not from the user, do not quote in your reply]\n" +
    notes.map((n) => `- ${n}`).join("\n") +
    "\n[END CHANNEL CONTEXT]\n\n"
  );
}

/**
 * Strip quoted-reply blocks from a plain-text email body. Email clients
 * pile up "On <date>, X wrote:" history on every reply; we want to hand
 * the agent only the most recent message. This is a heuristic — perfect
 * quote stripping is impossible — so we err on the side of keeping
 * content rather than dropping it.
 */
function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Classic single-line attribution: "On <date>, X wrote:"
    if (/^On .* wrote:\s*$/.test(line)) break;

    // "-- Original Message --" separator (Outlook, some MUAs).
    if (/^-{2,} ?Original Message ?-{2,}$/i.test(line)) break;

    // Apple Mail forwarded message header.
    if (/^Begin forwarded message:\s*$/i.test(line)) break;

    // Horizontal rule of underscores (used by some Exchange/Outlook
    // clients to separate the reply from the quoted thread). Require
    // at least 10 so we don't false-match short markdown rules.
    if (/^_{10,}\s*$/.test(line)) break;

    // Gmail mobile and other clients wrap the "On <date>, X wrote:"
    // attribution across 2-4 lines. We detect this by: a line starting
    // with "On " where a later line within the next 4 ends in "wrote:"
    // with nothing substantive in between. Without this, the quote
    // block leaks into the prompt and every reply ends up a rat's nest
    // of history.
    if (/^On\b/.test(line)) {
      const lookahead = lines.slice(i + 1, i + 5);
      if (lookahead.some((l) => /wrote:\s*$/.test(l))) break;
    }

    // Outlook-style quoted header block:
    //   From: Someone <a@b>
    //   Sent: Monday, April 14, 2026 3:45 PM
    //   To: Me <c@d>
    //   Subject: Re: something
    // Require THREE consecutive (within a small window) to avoid
    // misfiring on a user who happens to type "From: " in their body.
    if (/^(From|Sent|To|Cc|Subject):\s+\S/.test(line)) {
      const lookahead = lines.slice(i, i + 5);
      const headerCount = lookahead.filter((l) =>
        /^(From|Sent|To|Cc|Subject):\s+\S/.test(l),
      ).length;
      if (headerCount >= 3) break;
    }

    out.push(line);
  }

  // Trailing cleanup: drop empty lines and lines that start with ">".
  while (
    out.length > 0 &&
    (out[out.length - 1] === "" || out[out.length - 1]!.startsWith(">"))
  ) {
    out.pop();
  }
  return out.join("\n").trim();
}

// ── Prompt fragment registration ─────────────────────────────
//
// The email channel has two rules (subject-line extraction and
// attachment flow) that only matter when the current turn came in via
// this connector. Registering here keeps those rules collocated with
// the connector that produces the channel in the first place.
//
// Registration is idempotent by id; the module-level call is safe to
// evaluate multiple times (tests, hot reload, factory re-creation).
registerPromptFragment({
  id: "channel:email-imap",
  category: "channel",
  predicate: (ctx) => ctx.inboundChannel === "email-imap",
  order: 10,
  content: [
    "EMAIL SUBJECT LINES: For substantial replies (more than two or three",
    "sentences), START your response with a single markdown H1 that summarizes",
    "the reply in 6-12 words. The email connector lifts that H1 out and uses",
    "it as the subject line in the user's inbox, then strips it from the body",
    "so it doesn't display twice. Make it scannable: lead with the topic and",
    "the result, not generic phrases. GOOD: `# Quantum computing roundup —",
    "5 papers, 2 worth reading`. GOOD: `# Saint Marys weather — sunny through",
    "Friday, rain Saturday`. BAD: `# Re: your request`. BAD: `# Here is the",
    "information you asked for`. BAD: `# Response`. For one-line answers",
    '("Yes, 3pm works for me", "Done — file is at C:/..."), skip the H1',
    "entirely; a subject line on a one-liner looks ridiculous. The H1 must",
    "describe WHAT the reply contains, never just announce that it exists.",
    "",
    "EMAIL ATTACHMENTS: When the user asks for something that naturally lives",
    "in a file — a report, a CSV, a generated image, a transcript, a PDF, a",
    "script — call email_attach_content(filename, content) in ONE call. It",
    "writes the file and queues the attachment atomically, so you cannot fail",
    "halfway through and leave yourself claiming an attachment that does not",
    "exist. Do NOT use file_copy for this — file_copy only duplicates files",
    "that already exist on disk, it cannot produce a new file from text",
    "content. Only fall back to file_write + email_attach if the file already",
    "exists, needs a subdirectory path, or you need overwrite semantics.",
    "Caps: 5 files per reply, 5 MB per file, 20 MB total. CRITICAL: if you",
    "attach a file, do NOT also paste the same content inline in the body.",
    'Pair each attachment with one short sentence in the body ("Attached',
    'q1_report.pdf — full numbers, charts on pages 3-5."). Inline only for',
    "content the user explicitly asked to be inline, or tiny (one or two",
    "lines). When in doubt: attach. Never end a reply with \"the report is at",
    'C:/some/path" — that path is on YOUR machine, not the user\'s.',
  ].join("\n"),
});

export function createEmailImapConnector(
  opts: EmailImapConnectorOptions,
): InboundConnector {
  const id = opts.id ?? "email-imap";
  const allow = new Set(
    opts.allowFromAddresses.map((a) => a.trim().toLowerCase()),
  );
  const fromAddress = opts.from ?? opts.user;
  const auditLog = opts.auditLog;
  // Phase 4.5 — when true, agent skips inbounds where it's only on Cc
  // and not addressed by name. Defaults true at the schema level; left
  // permissive here for tests that bypass schema parsing.
  const replyOnlyWhenAddressed = opts.replyOnlyWhenAddressed !== false;
  const outboundRecipients = (opts.outboundTo?.length
    ? opts.outboundTo
    : opts.allowFromAddresses
  ).map((a) => a.trim().toLowerCase());
  const ImapCtor = opts.imapFactory ?? ImapFlow;
  const smtpCreate = opts.smtpFactory ?? nodemailer.createTransport;

  let client: ImapFlow | undefined;
  let transporter: Transporter | undefined;
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let stopped = false;

  async function pollOnce(handler: InboundHandler): Promise<void> {
    if (!client || polling || stopped) return;
    polling = true;
    let lock: { release: () => void } | undefined;
    try {
      lock = await client.getMailboxLock(opts.mailbox);
      // Search for unseen messages. imapflow returns an array of UIDs.
      const allUids = await client.search({ seen: false }, { uid: true });
      if (!allUids || allUids.length === 0) return;

      // Per-tick rate limit: a flood of unseen messages (compromised
      // allowlisted account, mass-forward, mailing list misconfig) would
      // otherwise drain tokens and stall the connector for minutes while
      // every message runs the full inference loop. Process the oldest
      // MAX_MESSAGES_PER_TICK and let the next poll pick up the rest —
      // back-pressure, not message loss.
      const uids = allUids.slice(0, MAX_MESSAGES_PER_TICK);
      if (allUids.length > MAX_MESSAGES_PER_TICK) {
        logger.warn(
          {
            id,
            unseen: allUids.length,
            processing: uids.length,
            deferred: allUids.length - uids.length,
          },
          "email-imap: unseen-message backlog exceeds per-tick cap, deferring overflow to next poll",
        );
      }

      for (const uid of uids) {
        if (stopped) break;
        try {
          await handleOneMessage(uid, handler);
        } catch (err) {
          logger.error(
            { err: formatErrorMessage(err), uid, id },
            "email-imap: failed to handle message",
          );
          // Mark seen anyway — better to lose one message than to
          // reprocess a poison pill on every tick forever.
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          } catch {
            // best effort
          }
        }
      }
    } catch (err) {
      logger.error(
        { err: formatErrorMessage(err), id },
        "email-imap: poll tick failed",
      );
    } finally {
      lock?.release();
      polling = false;
    }
  }

  async function handleOneMessage(
    uid: number,
    handler: InboundHandler,
  ): Promise<void> {
    if (!client || !transporter) return;

    const msg = await client.fetchOne(
      String(uid),
      { source: true, envelope: true },
      { uid: true },
    );
    if (!msg || !msg.source) {
      logger.warn({ uid, id }, "email-imap: empty fetch result");
      return;
    }

    const parsed = await simpleParser(msg.source);
    const sender = extractAddress(parsed.from?.value ?? parsed.from);
    const subject = parsed.subject ?? "";
    const messageId = parsed.messageId ?? msg.envelope?.messageId ?? undefined;

    // Per RFC 5322 §3.6.4, every message SHOULD carry a Message-Id.
    // Without one, we cannot thread the reply (no In-Reply-To/References)
    // and cannot tie this inbound to a thread root, so the session
    // collapses to one-per-sender. That's the safe fallback, but it's
    // also a signal of a misbehaving sender or a mailing list that
    // strips headers — surface it explicitly so an operator can see it
    // rather than silently degrading thread routing.
    if (!messageId) {
      logger.warn(
        { uid, id, sender, subject },
        "email-imap: inbound has no Message-Id — outbound reply will be unthreaded, session will fall back to sender-only key",
      );
    }

    if (!sender) {
      logger.warn({ uid, id }, "email-imap: no parseable sender, dropping");
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      return;
    }
    if (!allow.has(sender)) {
      logger.warn(
        { uid, id, sender },
        "email-imap: sender not in allowFromAddresses, dropping",
      );
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      return;
    }

    // RFC 5322 From: is unauthenticated. The receiving MTA's verdicts
    // for SPF/DKIM/DMARC live in `Authentication-Results` (RFC 8601).
    // Refuse mail from an allowlisted sender that the upstream MTA
    // marked as a hard fail — a compromised mailbox is out of scope,
    // but obvious header spoofs from outside that mailbox are not.
    // RT-2026-04-30-003.
    const authVerdict = parseAuthenticationResults(parsed.headers);
    if (authVerdict.failed) {
      logger.warn(
        { uid, id, sender, verdicts: authVerdict.verdicts },
        "email-imap: allowlisted sender failed upstream auth (SPF/DKIM/DMARC) — dropping as likely spoof",
      );
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      return;
    }

    // Capture the full recipient list so reply-all keeps multi-party
    // threads intact. Everyone who was in To: or Cc: on the inbound
    // (minus us and the sender, who goes into To:) becomes the reply's
    // Cc:. Without this, a three-person thread collapses to a 1:1 on
    // the first agent reply — everyone else silently falls off.
    // mailparser types parsed.to / parsed.cc as AddressObject | AddressObject[].
    // extractAllAddresses walks both shapes, so hand it the raw value.
    const originalTo = extractAllAddresses(parsed.to);
    const originalCc = extractAllAddresses(parsed.cc);
    const selfAddr = extractAddress(fromAddress) ?? "";
    const ccSeen = new Set<string>([sender, selfAddr].filter((a) => a.length > 0));
    const replyCc: string[] = [];
    for (const addr of [...originalTo, ...originalCc]) {
      if (!ccSeen.has(addr)) {
        ccSeen.add(addr);
        replyCc.push(addr);
      }
    }

    // Classify the inbound shape (forward vs direct, 1:1 vs group)
    // and extract the body together — the forward signal now considers
    // body markers too (a user-edited subject without Fwd: but a body
    // containing "Begin forwarded message:" is still a forward), and
    // the forward/direct distinction governs whether stripQuotedReply
    // is safe to run. See selectInboundBody.
    const rawBody = (parsed.text ?? "").toString();
    const shape = classifyInbound({
      subject,
      ccCount: replyCc.length,
      rawBody,
    });

    const strippedBody = selectInboundBody(rawBody, shape.isForward);

    // Subject-only inbound handling: on phones especially, it's common to
    // fire off a one-liner in the subject with an empty body — "what's
    // the build status?", "remind me to call mom at 5", etc. Rejecting
    // those as empty would feel broken to a user who just typed a
    // perfectly valid question into the Subject field. If the stripped
    // body is empty but the subject has real content, promote the
    // subject to the prompt body. `trimmedSubject` excludes pure "Re:"
    // prefixes because those don't carry new instruction.
    const trimmedSubject = stripReplyOrForwardPrefix(subject);
    let body = strippedBody;
    if (!body) {
      if (trimmedSubject.length > 0) {
        logger.info(
          { uid, id, sender, subject: trimmedSubject },
          "email-imap: empty body, promoting subject to prompt",
        );
        body = trimmedSubject;
      } else {
        logger.warn(
          { uid, id, sender },
          "email-imap: empty body AND empty subject, dropping",
        );
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        return;
      }
    }

    // Inbound attachments are deliberately NOT processed — the
    // prompt-injection surface from arbitrary user-supplied files is
    // the wrong thing to open up pre-ship (see Phase 9 in ROADMAP.md
    // and memory/project_email_attachments_roadmap.md). Make the
    // ignore explicit: log each attachment per RFC operator-side, and
    // tell the agent in the channel-context block that files were
    // attached but are not visible. Without this, mailparser silently
    // drops them and the agent can hallucinate "I've reviewed the
    // attachment" — same failure mode as the 2026-04-24 incident.
    const ignoredAttachments = extractIgnoredInboundAttachments(parsed.attachments);
    if (ignoredAttachments.length > 0) {
      for (const a of ignoredAttachments) {
        logger.warn(
          {
            uid,
            id,
            sender,
            filename: a.filename,
            sizeBytes: a.sizeBytes,
            contentType: a.contentType,
          },
          "email-imap: inbound attachment ignored — inbound attachment processing is deliberately deferred (Phase 9, prompt-injection threat)",
        );
      }
    }

    // Phase 4.5 — CC detection. If the agent is only on Cc (not the
    // primary To addressee) AND the inbound subject/body does not name
    // the agent explicitly, treat the message as informational and do
    // NOT auto-reply. The agent silently observes — this is the right
    // behavior for the common case (someone CCs the agent on a thread
    // intended for a colleague). Operators who run a generic local-part
    // ("info@", "contact@") can disable this with
    // connectors.emailImap.replyOnlyWhenAddressed = false.
    const selfAddrLower = (extractAddress(fromAddress) ?? "").toLowerCase();
    if (replyOnlyWhenAddressed && selfAddrLower) {
      const onTo = wasAgentInTo(parsed.to, selfAddrLower);
      if (!onTo) {
        const named = isAddressedByName(subject, body, selfAddrLower);
        if (!named) {
          logger.info(
            { uid, id, sender, subject, ccCount: replyCc.length },
            "email-imap: skipping inbound — agent on Cc only, not addressed by name (Phase 4.5; set replyOnlyWhenAddressed:false to disable)",
          );
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          return;
        }
      }
    }

    // Channel-context note prepended to the prompt envelope (forward
    // framing, multi-party warning, ignored attachments, etc.). The
    // user never sees it.
    const inboundContext = buildInboundContext(shape, ignoredAttachments);
    const bodyWithContext = inboundContext ? inboundContext + body : body;

    // Thread root = the first id in References, or this message's own id
    // if it's the start of a chain. Tying the session key to the thread
    // root means each conversation = one session, instead of every email
    // from a given sender sharing one transcript and bleeding context
    // across unrelated topics.
    const threadRoot = computeThreadRoot(parsed.references, messageId);

    const inboundMsg: InboundMessage = {
      sender,
      body: bodyWithContext,
      subject,
      threadId: threadRoot,
    };

    logger.info(
      { uid, id, sender, subject, bodyLen: body.length },
      "email-imap: dispatching inbound message",
    );

    const reply = await handler(inboundMsg);

    // Smart subject lines: if the agent led its reply with a markdown
    // H1, lift it out and use it as the subject. The H1 is then stripped
    // from the body so the user doesn't see the same headline twice
    // (once as subject, once as the first heading). Falls back to the
    // inbound subject if the agent didn't lead with an H1.
    const { subject: agentSubject, body: bodyForRender } = extractSubjectAndStrip(reply.body);

    const replySubject = truncateSubject(
      buildReplySubject(agentSubject ?? subject),
    );

    // Build RFC 5322 threading headers from the inbound's full chain,
    // not just its own Message-ID. See buildThreadHeaders for why.
    const threadHeaders = buildThreadHeaders(messageId, parsed.references);

    // Long-response degradation: if the reply is too big to read
    // comfortably in an inbox pane, keep a short preview inline and
    // attach the full markdown. See degradeLongResponse for rationale.
    // Pass the subject so the attachment filename derives from it
    // (e.g. `quantum-computing-roundup.md` instead of generic
    // `full-response.md`). Prefer the agent-emitted H1 when present —
    // the agent picked it specifically as a title — and fall back to
    // the inbound subject so even forwarded chains get a readable name.
    const degraded = degradeLongResponse(bodyForRender, undefined, {
      subject: agentSubject ?? subject,
    });
    const finalBody = degraded.body;

    // Convert any agent-staged attachments (queued via email_attach
    // during the inference loop) into nodemailer's attachment format.
    // The agent has already validated paths/sizes; we just forward.
    // The degraded full-response.md (if any) is prepended so it sorts
    // first in mail clients that order attachments by append order.
    const stagedAttachments = reply.attachments?.length
      ? reply.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { contentType: a.contentType } : {}),
        }))
      : [];
    const mailAttachments =
      degraded.attachment || stagedAttachments.length > 0
        ? [
            ...(degraded.attachment ? [degraded.attachment] : []),
            ...stagedAttachments,
          ]
        : undefined;

    logger.info(
      {
        id,
        uid,
        replySubject,
        originalBodyLen: bodyForRender.length,
        finalBodyLen: finalBody.length,
        degraded: Boolean(degraded.attachment),
        replyBodyPreview: finalBody.slice(0, 120),
        replyBodyEmpty: finalBody.length === 0,
        agentDerivedSubject: Boolean(agentSubject),
        inboundMessageId: messageId ?? null,
        inboundReferences: parsed.references ?? null,
        inReplyTo: threadHeaders?.inReplyTo ?? null,
        references: threadHeaders?.references ?? null,
        ccCount: replyCc.length,
        attachmentCount: mailAttachments?.length ?? 0,
        attachmentBytes:
          mailAttachments?.reduce((n, a) => n + (a.content as Buffer).length, 0) ?? 0,
      },
      "email-imap: about to sendMail",
    );

    // Render markdown → multipart/alternative. The agent's body is
    // markdown; sending only text/plain leaves raw `**bold**` and `#`
    // marks visible in inboxes, which makes the assistant feel janky.
    // The HTML renderer is in email-render.ts (kept separate for
    // unit-testing without spinning up SMTP).
    const rendered = renderEmailReply(finalBody);

    // SMTP delivery is wrapped in its own try/catch so we can distinguish
    // "couldn't deliver the reply" from "couldn't parse the inbound". The
    // outer pollOnce catch marks any thrown message \Seen to avoid poison-
    // pill loops, which is right for parse errors but catastrophic for
    // delivery failures: a transient SMTP outage would silently drop every
    // message in flight with no reply to the user. By catching here and
    // returning early, delivery failures leave the inbound unseen so the
    // next poll tick retries it.
    //
    // We also race sendMail against a hard wall-clock timeout. Nodemailer
    // honors its own connection/greeting/socketTimeout for *idle* failures
    // but some real-world hangs (post-DATA stalls, slow TLS renegotiation,
    // misbehaving relays) can blow past those because data is still
    // flowing. The race is the belt to nodemailer's suspenders — bounded
    // wall-clock guarantee that we get back to polling no matter how
    // creative the failure mode.
    //
    // 180 seconds is calibrated against an observed real-world Gmail
    // SMTP stall of 117 seconds for a single message — Gmail occasionally
    // takes nearly 2 minutes to acknowledge a send under load. A timeout
    // shorter than that would abort legitimate sends and trigger duplicate
    // delivery on the next poll. 180s gives us a comfortable margin while
    // still being a tiny fraction of nodemailer's catastrophic 10-minute
    // socket default.
    const SEND_HARD_TIMEOUT_MS = 180_000;
    const sendStartedAt = Date.now();
    diagnostics.emit("message.delivery.started", {
      channel: id,
      deliveryKind: "text",
    });
    try {
      await Promise.race([
        transporter.sendMail({
          from: fromAddress,
          to: sender,
          ...(replyCc.length > 0 ? { cc: replyCc } : {}),
          subject: replySubject,
          text: rendered.text,
          html: rendered.html,
          ...(threadHeaders ?? {}),
          ...(mailAttachments ? { attachments: mailAttachments } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `sendMail wall-clock timeout after ${SEND_HARD_TIMEOUT_MS}ms`,
                ),
              ),
            SEND_HARD_TIMEOUT_MS,
          ),
        ),
      ]);
      diagnostics.emit("message.delivery.completed", {
        channel: id,
        deliveryKind: "text",
        durationMs: Date.now() - sendStartedAt,
      });

      // Per-attachment audit chain entry. Closes Phase 4.4.7: the audit
      // chain now records every byte that left the box on this send,
      // not just the staging tool call. Pseudo-tool pattern keeps these
      // in the same chain as agent tool calls so a single audit query
      // covers "everything the box did this turn." Audit-record failures
      // must not break the delivery loop, so each entry is wrapped.
      if (auditLog && mailAttachments && mailAttachments.length > 0) {
        const auditTimestamp = new Date().toISOString();
        const auditDuration = Date.now() - sendStartedAt;
        for (const a of mailAttachments) {
          const buf = a.content as Buffer;
          try {
            auditLog.record({
              timestamp: auditTimestamp,
              sessionKey: `email:${threadRoot}`,
              toolId: "__email_attachment_sent",
              toolName: "email_attachment_sent",
              effectClass: "privileged",
              callId: randomUUID(),
              parameters: {
                filename: a.filename,
                sizeBytes: buf.length,
                sha256: createHash("sha256").update(buf).digest("hex"),
                recipient: sender,
                ...(replyCc.length > 0 ? { cc: replyCc } : {}),
                ...(threadHeaders?.inReplyTo
                  ? { inReplyTo: threadHeaders.inReplyTo }
                  : {}),
              },
              resultStatus: "success",
              durationMs: auditDuration,
            });
          } catch (err) {
            logger.warn(
              { err: formatErrorMessage(err), filename: a.filename, id, uid },
              "email-imap: failed to record attachment audit entry",
            );
          }
        }
      }
    } catch (err) {
      const msg = formatErrorMessage(err);
      logger.error(
        {
          err: msg,
          uid,
          id,
          sender,
          replySubject,
        },
        "email-imap: SMTP sendMail failed — leaving message unseen for retry",
      );
      // Surface to agent context so the agent does not keep behaving as if
      // prior replies went out. Target is the recipient; kind classifies
      // timeout vs auth vs transient so the agent can reason about it.
      const kind = /timeout/i.test(msg)
        ? "smtp_timeout"
        : /auth|535|530/i.test(msg)
          ? "smtp_auth"
          : "smtp_send_failed";
      diagnostics.emit("message.delivery.error", {
        channel: id,
        deliveryKind: "text",
        durationMs: Date.now() - sendStartedAt,
        errorCategory: kind,
      });
      recordConnectorFailure({
        connectorId: id,
        kind,
        detail: msg.slice(0, 200),
        target: sender,
      });
      return;
    }

    await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    logger.info(
      { uid, id, sender, replyLen: reply.body.length, ccCount: replyCc.length },
      "email-imap: reply sent",
    );
  }

  async function start(handler: InboundHandler): Promise<void> {
    if (client) throw new Error("email-imap: already started");
    stopped = false;

    client = new ImapCtor({
      host: opts.imapHost,
      port: opts.imapPort,
      secure: opts.imapPort === 993,
      auth: { user: opts.user, pass: opts.password },
      logger: false,
    });
    await client.connect();

    // Explicit timeouts. Nodemailer's defaults are catastrophically
    // generous for our workload — socketTimeout is 10 *minutes* and
    // connectionTimeout is 2 minutes. Combined with pollOnce holding a
    // `polling = true` lock for the whole handleOneMessage call, a
    // single sticky Gmail SMTP connection freezes the entire connector
    // for the better part of an hour with zero log output. We bound
    // every stage tightly so the failure becomes visible (and retryable)
    // within a minute instead.
    transporter = smtpCreate({
      host: opts.smtpHost,
      port: opts.smtpPort,
      secure: opts.smtpPort === 465,
      auth: { user: opts.user, pass: opts.password },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    });

    registerOutboundConnector({
      id,
      name: "email-imap",
      trustLevel: "trusted",
      async deliver({ content, killUrl, reason }) {
        if (!transporter) {
          return { ok: false, error: "email connector is not started" };
        }
        const body = killUrl
          ? `${content}\n\n---\nStop this agent run: ${killUrl}`
          : content;
        const rendered = renderEmailReply(body);
        const subject = truncateSubject(
          reason ? `CrabMeat: ${reason}` : "CrabMeat update",
        );
        try {
          const info = await transporter.sendMail({
            from: fromAddress,
            to: outboundRecipients,
            subject,
            text: rendered.text,
            html: rendered.html,
          });
          return {
            ok: true,
            deliveryId:
              typeof info.messageId === "string" ? info.messageId : undefined,
          };
        } catch (err: unknown) {
          return { ok: false, error: formatErrorMessage(err) };
        }
      },
    });

    logger.info(
      {
        id,
        imapHost: opts.imapHost,
        smtpHost: opts.smtpHost,
        user: opts.user,
        allowCount: allow.size,
        pollIntervalMs: opts.pollIntervalMs,
      },
      "email-imap: connector started",
    );

    // Schedule recurring polls. We do NOT chain the first poll inside
    // start() — start() should resolve quickly so the gateway can keep
    // booting. The first tick happens after one interval.
    timer = setInterval(() => {
      void pollOnce(handler);
    }, opts.pollIntervalMs);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (client) {
      try {
        await client.logout();
      } catch (err) {
        logger.warn(
          { err: formatErrorMessage(err), id },
          "email-imap: error during logout",
        );
      }
      client = undefined;
    }
    if (transporter) {
      transporter.close();
      transporter = undefined;
    }
    unregisterOutboundConnector(id);
    logger.info({ id }, "email-imap: connector stopped");
  }

  return {
    id,
    name: "email-imap",
    trustLevel: "trusted",
    start,
    stop,
  };
}

// Exported for tests.
export const _internal = {
  extractAddress,
  extractAllAddresses,
  stripQuotedReply,
  buildThreadHeaders,
  classifyInbound,
  bodyLooksForwarded,
  buildInboundContext,
  computeThreadRoot,
  selectInboundBody,
  hasReplyPrefix,
  stripReplyOrForwardPrefix,
  buildReplySubject,
  extractIgnoredInboundAttachments,
  wasAgentInTo,
  isAddressedByName,
};
