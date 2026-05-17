/**
 * email-render — convert agent markdown output into the {text, html} pair
 * we hand to nodemailer for multipart/alternative replies.
 *
 * Why: the agent emits markdown freely (headers, bold, lists, code fences,
 * links). Sent as text/plain, that arrives in inboxes as raw `**bold**`
 * and `# header` noise — looks janky, undermines the "feels like a real
 * correspondent" goal. Sending multipart/alternative with both lets each
 * client (Gmail web, Apple Mail, Outlook, mobile) pick whichever it
 * renders best.
 *
 * Security notes:
 * - marked v15+ does NOT escape inline HTML by default — a literal
 *   `<script>` in the markdown source passes straight through. Since the
 *   markdown comes from a model whose output is influenced by user input,
 *   we run the rendered HTML through `sanitize-html` with a strict tag
 *   allowlist before wrapping. This is the XSS guardrail; do not weaken
 *   the allowlist without a corresponding test.
 * - The HTML wrapper is a static, hand-written shell. We never interpolate
 *   anything into it that came from outside this file.
 */

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({
  // gfm: GitHub-flavored markdown — handles fenced code, tables,
  // strikethrough, autolinks. The shape the model already emits.
  gfm: true,
  // breaks: treat single newlines as <br>. Closer to how the model
  // intends its output to read in an email body where users write in
  // tighter line breaks than blog markdown.
  breaks: true,
});

/**
 * Minimal style block. Goal is "readable on every client" not
 * "pixel-perfect" — Outlook in particular ignores most CSS, so anything
 * fancy is wasted bytes. Inline-style approach used because Gmail strips
 * <style> blocks in some configurations; nodemailer can do automatic
 * inlining if we ever need it, but for now the body element styles
 * inherit and the rest of the document is already plain enough.
 */
const HTML_SHELL_OPEN =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<style>" +
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:680px}" +
  "pre{background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-family:Menlo,Consolas,monospace;font-size:13px}" +
  "code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:13px}" +
  "pre code{background:transparent;padding:0}" +
  "blockquote{border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555}" +
  "h1,h2,h3{line-height:1.25}" +
  "table{border-collapse:collapse}" +
  "th,td{border:1px solid #ddd;padding:6px 10px}" +
  "</style></head><body>";
const HTML_SHELL_CLOSE = "</body></html>";

export interface RenderedEmail {
  /** Plain-text body (what plaintext-only clients see). */
  text: string;
  /** HTML body wrapped in a minimal style shell. */
  html: string;
}

export interface DegradedResponse {
  /** The (possibly shortened) body to render inline in the email. */
  body: string;
  /**
   * A synthetic attachment containing the full original markdown,
   * or undefined if the body was small enough to send inline as-is.
   */
  attachment?: {
    filename: string;
    content: Buffer;
    contentType: string;
  };
}

/**
 * Soft cap on inline email body length, in characters of source markdown.
 * Replies longer than this get degraded into an inline preview plus a
 * `.md` attachment containing the full response. 16,000 chars is roughly
 * 3,000 words / a ~6 minute read — past that, Gmail's reading pane turns
 * into a scroll wall and the user effectively can't skim the reply.
 *
 * Exported so tests and callers can override it if a recipient has a
 * known-different tolerance.
 */
export const DEFAULT_INLINE_BODY_LIMIT = 16_000;

/** Inline preview length (chars) when we do degrade a long response. */
const DEFAULT_PREVIEW_CHARS = 800;

/** Maximum length of the slug derived from a subject for use as a filename. */
const FILENAME_SLUG_MAX = 60;

/**
 * Build an ASCII-safe filename slug from a subject line. Used to derive
 * the long-response attachment filename so the user sees, for example,
 * `quantum-computing-roundup.md` instead of a generic
 * `full-response.md`. Non-ASCII characters are dropped (mail clients
 * vary in their tolerance for UTF-8 attachment names — keeping ASCII
 * sidesteps the problem entirely). Returns the empty string when the
 * input has no usable characters; callers should fall back to a
 * default filename in that case.
 */
export function slugifyForFilename(
  subject: string,
  maxLen: number = FILENAME_SLUG_MAX,
): string {
  return subject
    .toLowerCase()
    .replace(/[^\w\s-]+/g, " ")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

/**
 * Truncate a string at a friendly boundary (paragraph > sentence > hard cut)
 * so the inline preview doesn't end mid-word. Never returns empty.
 */
function takePreview(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const chunk = body.slice(0, maxChars);

  // Paragraph breaks are deliberate author boundaries, so we honor the
  // FIRST one generously — even a short "TL;DR\n\n" block above a giant
  // wall of text is exactly what the inbox pane should show. The only
  // threshold is that we skip a break at position 0 (empty preview).
  const firstPara = chunk.indexOf("\n\n");
  if (firstPara > 0) return chunk.slice(0, firstPara).trimEnd();

  // No paragraph break at all in-window: look for a sentence boundary,
  // but require it to be in the back half so we don't produce a 30-char
  // preview from a single short opener.
  const halfway = maxChars * 0.5;
  const lastSentence = Math.max(
    chunk.lastIndexOf(". "),
    chunk.lastIndexOf("! "),
    chunk.lastIndexOf("? "),
    chunk.lastIndexOf(".\n"),
    chunk.lastIndexOf("!\n"),
    chunk.lastIndexOf("?\n"),
  );
  if (lastSentence > halfway) return chunk.slice(0, lastSentence + 1).trimEnd();

  // No good boundary — hard cut with an ellipsis.
  return chunk.trimEnd() + "…";
}

/**
 * If the agent reply is too long for a comfortable inline email body,
 * degrade gracefully: keep a short inline preview (first paragraph-ish),
 * add a footer telling the user the full response is attached, and
 * surface the full markdown as an attachment.
 *
 * Design notes:
 * - Pure function, no I/O. The caller decides what to do with the
 *   returned attachment (merge into nodemailer's attachments array).
 * - Preserves the original markdown verbatim in the attachment — the
 *   preview is cut at a paragraph/sentence boundary, not reflowed, so
 *   the full version in the attachment reads exactly as the agent wrote it.
 * - Filename is `full-response.md` (not `response.md`) to minimize the
 *   chance of colliding with an attachment the agent itself staged.
 * - Word count in the footer uses whitespace splitting, which overcounts
 *   slightly for markdown-heavy output but is good enough as a signal
 *   of "how much stuff is in here."
 */
export function degradeLongResponse(
  body: string,
  limit: number = DEFAULT_INLINE_BODY_LIMIT,
  opts: { subject?: string } = {},
): DegradedResponse {
  if (body.length <= limit) return { body };

  const preview = takePreview(body, DEFAULT_PREVIEW_CHARS);
  const wordCount = body.split(/\s+/).filter((s) => s.length > 0).length;
  const charCount = body.length;

  const slug = opts.subject ? slugifyForFilename(opts.subject) : "";
  const filename = slug ? `${slug}.md` : "full-response.md";

  const footer =
    `\n\n---\n\n` +
    `*Full response attached as \`${filename}\` — ` +
    `${charCount.toLocaleString()} characters, ` +
    `${wordCount.toLocaleString()} words total. ` +
    `The preview above is the first paragraph or two; the attachment has everything.*`;

  return {
    body: preview + footer,
    attachment: {
      filename,
      content: Buffer.from(body, "utf8"),
      contentType: "text/markdown; charset=utf-8",
    },
  };
}

export interface SubjectExtraction {
  /**
   * The extracted subject line (without the leading `#`), or undefined
   * if the body did not open with an H1.
   */
  subject?: string;
  /**
   * The body with the leading H1 (and any blank lines between it and the
   * next content) removed. If no H1 was extracted, the body is returned
   * unchanged.
   */
  body: string;
}

/**
 * Maximum subject length we'll emit. Email RFCs technically allow up to
 * 998 chars per line but most clients truncate around 70-90 in the
 * inbox view, and the surrounding "Re: " plus ellipsis costs a few more.
 * 120 is a comfortable upper bound that keeps the line scannable.
 */
export const MAX_SUBJECT_LEN = 120;

/**
 * Cap a subject line at MAX_SUBJECT_LEN, replacing the tail with `...`.
 * Trims trailing whitespace before the ellipsis so we don't emit
 * "long phrase  ..." with a stray space. Pure function — no I/O.
 *
 * Exported so both subject-derivation paths (agent-emitted H1 in
 * extractSubjectAndStrip, AND the inbound→Re:-prefixed fallback in
 * email-imap.ts) cap by the same rule. Without this, only the H1
 * path was capped and a 250-char inbound subject came back verbatim.
 */
export function truncateSubject(subject: string, maxLen: number = MAX_SUBJECT_LEN): string {
  if (subject.length <= maxLen) return subject;
  return subject.slice(0, maxLen - 3).trimEnd() + "...";
}

/**
 * If a markdown body opens with an H1, lift it out as a subject line and
 * return the remaining body with that H1 stripped.
 *
 * Why this exists: the agent's reply body is what we send. If the model
 * leads with "# Quantum computing highlights — 5 papers summarized" we
 * want THAT to be the email subject in the user's inbox, not the
 * generic "Re: <whatever they originally asked>". The body strip avoids
 * the "subject line then identical H1 immediately below" AI-newsletter
 * look — once the H1 is the subject, repeating it as a heading in the
 * body adds nothing.
 *
 * Only the FIRST non-blank line is checked. An H1 buried mid-document
 * is a section header, not a title — leave it alone.
 */
export function extractSubjectAndStrip(body: string): SubjectExtraction {
  const lines = body.split(/\r?\n/);

  // Find the first non-blank line.
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "") {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return { body };

  // ATX H1 only — `# text`. We deliberately do NOT match `## `, setext
  // underlines, or `#text` (no space) because those aren't conventional
  // titles and we don't want to falsely strip them.
  const match = /^#\s+(.+?)\s*#*\s*$/.exec(lines[firstIdx]!.trim());
  if (!match) return { body };

  let subject = match[1]!.trim();
  if (subject.length === 0) return { body };
  subject = truncateSubject(subject);

  // Drop everything up to and including the H1 line, then any blank
  // lines that immediately followed it — the agent typically writes
  // `# Title\n\nBody...` and we want the body to start cleanly.
  const after = lines.slice(firstIdx + 1);
  while (after.length > 0 && after[0]!.trim() === "") {
    after.shift();
  }

  return { subject, body: after.join("\n") };
}

/**
 * Strip markdown markers down to a more presentable plain-text version.
 * Not a full markdown→text transform — just the markers that look ugliest
 * in a plain-text email client. Headers lose their `#`s, list bullets
 * become hyphens, fenced code blocks lose the fences but keep contents.
 *
 * Bold/italic markers are intentionally preserved — they're already
 * readable inline (*emphasis* and **strong** read fine in plaintext) and
 * stripping them risks ambiguity with literal asterisks in the content.
 */
function markdownToReadablePlainText(md: string): string {
  let out = md;
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^[ \t]*[-*+]\s+/gm, "- ");
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, "");
  out = out.replace(/```/g, "");
  return out;
}

/**
 * Tag/attribute allowlist. Covers exactly what `marked` produces from
 * gfm markdown — headers, paragraphs, lists, code, blockquotes, tables,
 * inline emphasis, links. Anything else (script, iframe, style tags
 * inside body, on* event handlers, etc.) is stripped.
 *
 * `a` allows href + title only; href is restricted to safe schemes
 * below. No `target` or `rel` because email clients largely ignore
 * them and they're not load-bearing for safety.
 */
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li",
    "a",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "title"],
  },
  // http(s) and mailto only. Blocks javascript:, data:, file:, etc.
  allowedSchemes: ["http", "https", "mailto"],
  // Disallow protocol-relative URLs to be safe — the model has no
  // reason to emit them and they're a known bypass vector.
  allowProtocolRelative: false,
};

/**
 * Render an agent-emitted markdown body into the {text, html} pair for
 * nodemailer. Pure function — no I/O, no side effects, easy to unit test.
 *
 * Pipeline: markdown → marked → sanitize-html → wrap in shell.
 */
/**
 * A line that's just digits + period (e.g. "4.", "12.") is the agent
 * answering with a number, not the start of an ordered list. marked
 * still parses it as `<ol start="N"><li></li></ol>`, and Gmail / most
 * email clients drop the start attribute and renumber from 1 — so the
 * recipient sees "1." regardless of what the agent said. Escaping the
 * period for these standalone markers keeps them text. Real list items
 * always have content after the marker on the same line, so this rule
 * does not affect them.
 */
function escapeBareOrderedMarkers(md: string): string {
  return md.replace(/^(\s*)(\d+)\.(\s*)$/gm, "$1$2\\.$3");
}

export function renderEmailReply(body: string): RenderedEmail {
  const text = markdownToReadablePlainText(body);
  const rawHtml = marked.parse(escapeBareOrderedMarkers(body), { async: false }) as string;
  const safeHtml = sanitizeHtml(rawHtml, SANITIZE_OPTS);
  const html = HTML_SHELL_OPEN + safeHtml + HTML_SHELL_CLOSE;
  return { text, html };
}
