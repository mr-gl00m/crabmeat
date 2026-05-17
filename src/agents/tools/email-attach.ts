/**
 * email_attach — stage a file as an outbound attachment on the next
 * inbound-channel reply (currently: email).
 *
 * The tool is a read-only stager: it validates the path against the
 * sandbox, reads the file into memory, and queues it under the current
 * session key. The actual send happens later in the inbound handler
 * closure (gateway/server.ts), which drains the queue after the
 * inference loop finishes and hands the attachments to the connector.
 *
 * Effect class: read. The tool itself never sends anything — it just
 * stages bytes — so it does not require write/network/exec privileges
 * and is plan-mode safe.
 *
 * Caps (Gmail-friendly defaults):
 *   - MAX_ATTACHMENTS_PER_SESSION = 5 files queued per turn
 *   - MAX_ATTACHMENT_BYTES         = 5 MB per file
 *   - MAX_TOTAL_ATTACHMENT_BYTES   = 20 MB across all queued files
 *   - MAX_ATTACHMENT_SESSIONS      = 256 (LRU eviction, like todo_write)
 *
 * The queue is drained on every reply send. If the agent stages files
 * but the inference loop hits an error before producing a body, the
 * queue is still drained (and discarded) by the handler closure to
 * prevent stale state leaking into the next conversation turn.
 */

import { stat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { registerToolHandler } from "./handlers.js";
import { jailPathReal, jailDenialMessage } from "./builtins.js";
import { redactToolResultSecrets } from "../../security/sanitize.js";
import type { ToolExecutionContext } from "./types.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";

export const MAX_ATTACHMENTS_PER_SESSION = 5;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_SESSIONS = 256;
export const MAX_ATTACHMENT_FILENAME_LEN = 200;

// Per-file and per-reply byte caps. Mutable so the email connector can
// raise/lower them via setEmailAttachmentLimits at startup based on the
// operator's connectors.emailImap config (attachmentMaxBytesPerFile /
// attachmentMaxBytesTotal). Defaults match Gmail-friendly limits and
// apply when no email connector is configured.
let maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES;
let maxTotalAttachmentBytes = DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES;

/**
 * Override the per-file and cumulative attachment caps. Called from
 * gateway/server.ts when an email connector is registered. Values must
 * be positive and totalMaxBytes must be >= maxBytes — the schema
 * enforces both, so this setter trusts its input.
 *
 * NOTE: caps are process-global. If a future build supports multiple
 * concurrent email connectors with different limits, this will need to
 * become per-connector keyed off a connector id passed in
 * ToolExecutionContext. Today only one email connector exists per
 * process, so global is fine.
 */
export function setEmailAttachmentLimits(opts: {
  maxBytes?: number;
  totalMaxBytes?: number;
}): void {
  if (opts.maxBytes !== undefined && opts.maxBytes > 0) {
    maxAttachmentBytes = opts.maxBytes;
  }
  if (opts.totalMaxBytes !== undefined && opts.totalMaxBytes > 0) {
    maxTotalAttachmentBytes = opts.totalMaxBytes;
  }
}

/** Read the live caps. Used by tests + diagnostics. */
export function getEmailAttachmentLimits(): {
  maxBytes: number;
  totalMaxBytes: number;
} {
  return { maxBytes: maxAttachmentBytes, totalMaxBytes: maxTotalAttachmentBytes };
}

/**
 * Backwards-compat exports — names that were public before the caps
 * became runtime-mutable. ES modules re-export `let` bindings live, so
 * importers see the current value of `maxAttachmentBytes` /
 * `maxTotalAttachmentBytes` on each read (override when one is set,
 * default otherwise). New code should call getEmailAttachmentLimits().
 */
export {
  maxAttachmentBytes as MAX_ATTACHMENT_BYTES,
  maxTotalAttachmentBytes as MAX_TOTAL_ATTACHMENT_BYTES,
};

export interface QueuedAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  sourcePath: string;
}

const queues: Map<string, QueuedAttachment[]> = new Map();

function touchSession(key: string): void {
  const existing = queues.get(key);
  if (existing !== undefined) {
    queues.delete(key);
    queues.set(key, existing);
  }
}

function ensureCapacity(): void {
  while (queues.size >= MAX_ATTACHMENT_SESSIONS) {
    const oldest = queues.keys().next().value;
    if (oldest === undefined) break;
    queues.delete(oldest);
  }
}

function getQueue(key: string): QueuedAttachment[] {
  return queues.get(key) ?? [];
}

function totalBytes(list: QueuedAttachment[]): number {
  let n = 0;
  for (const a of list) n += a.content.length;
  return n;
}

/**
 * Drain (remove and return) the attachment queue for a session.
 * Called by the inbound handler closure after the inference loop
 * completes. Always clears the queue, even if the caller decides not
 * to use the result, so stale attachments do not leak into the next
 * turn.
 */
export function drainAttachments(sessionKey: string): QueuedAttachment[] {
  const list = queues.get(sessionKey);
  queues.delete(sessionKey);
  return list ?? [];
}

/** For tests — wipe all queue state and restore default caps. */
export function _resetEmailAttachState(): void {
  queues.clear();
  maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES;
  maxTotalAttachmentBytes = DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES;
}

/** For tests — peek at the queue without draining. */
export function _peekAttachments(sessionKey: string): QueuedAttachment[] {
  return [...(queues.get(sessionKey) ?? [])];
}

/** For tests — number of tracked sessions. */
export function _attachmentSessionCount(): number {
  return queues.size;
}

/**
 * Heuristic: does this buffer look like decodable text rather than a
 * binary blob? Used to gate the credential-pattern scan in the attach
 * path — running detectLeaks against PDF/image bytes wastes cycles and
 * produces meaningless false positives from random byte sequences that
 * happen to look like base64.
 *
 * Sample the first 4 KB and look for the binary tells: NUL bytes are
 * a hard signal (UTF-8 text never contains them), and excess control
 * bytes beyond tab/LF/CR strongly suggest non-text. The 3% threshold
 * is loose enough that a CSV with a couple of stray control bytes
 * still classifies as text, tight enough that a JPEG's header doesn't.
 */
function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let controlChars = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09) controlChars++;
    else if (byte > 0x0d && byte < 0x20) controlChars++;
  }
  return controlChars / sample.length < 0.03;
}

/**
 * Lightweight content-type guess from a file extension. We deliberately
 * do not pull in mime-db; the connector forwards this string as-is to
 * nodemailer, which falls back to application/octet-stream if it is
 * undefined. The guess is best-effort.
 */
function guessContentType(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "pdf": return "application/pdf";
    case "txt": case "log": case "md": return "text/plain";
    case "html": case "htm": return "text/html";
    case "csv": return "text/csv";
    case "json": return "application/json";
    case "xml": return "application/xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "zip": return "application/zip";
    case "tar": return "application/x-tar";
    case "gz": return "application/gzip";
    case "doc": return "application/msword";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls": return "application/vnd.ms-excel";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default: return undefined;
  }
}

function sanitizeFilename(name: string): string {
  // Strip directory components — only the leaf name reaches the recipient.
  const leaf = basename(name).trim();
  // Remove characters that are unsafe in email attachment filenames on
  // common clients: control chars, path separators, quote marks.
  // eslint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[\x00-\x1f\x7f"\\/:*?<>|]/g, "_");
  return cleaned.slice(0, MAX_ATTACHMENT_FILENAME_LEN) || "attachment";
}

async function handleEmailAttach(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ content: string; isError?: boolean; outputs?: Record<string, unknown> }> {
  if (!context?.sessionKey) {
    return {
      content: "email_attach is only available inside an active session.",
      isError: true,
    };
  }
  const sessionKey = context.sessionKey;

  const path = typeof params.path === "string" ? params.path.trim() : "";
  if (!path) {
    return {
      content: "email_attach: 'path' is required (the file to attach, inside the workspace).",
      isError: true,
    };
  }

  const filenameOverride =
    typeof params.filename === "string" && params.filename.trim().length > 0
      ? params.filename.trim()
      : undefined;

  const resolved = await jailPathReal(path);
  if (!resolved) {
    return {
      content: `email_attach: ${jailDenialMessage(path)}`,
      isError: true,
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch (err) {
    const msg = formatErrorMessage(err);
    if (msg.includes("ENOENT")) {
      return { content: `email_attach: file not found: '${path}'`, isError: true };
    }
    return { content: `email_attach: error reading '${path}': ${msg}`, isError: true };
  }
  if (!fileStat.isFile()) {
    return {
      content: `email_attach: '${path}' is not a regular file.`,
      isError: true,
    };
  }
  if (fileStat.size === 0) {
    return {
      content: `email_attach: '${path}' is empty (0 bytes); refusing to attach an empty file.`,
      isError: true,
    };
  }
  if (fileStat.size > maxAttachmentBytes) {
    return {
      content:
        `email_attach: '${path}' is too large ` +
        `(${(fileStat.size / 1024 / 1024).toFixed(1)} MB > ${maxAttachmentBytes / 1024 / 1024} MB per-file cap).`,
      isError: true,
    };
  }

  const existing = getQueue(sessionKey);
  if (existing.length >= MAX_ATTACHMENTS_PER_SESSION) {
    return {
      content:
        `email_attach: queue full — already ${existing.length}/${MAX_ATTACHMENTS_PER_SESSION} attachments staged. ` +
        `Send the current reply first, or reduce the number of files.`,
      isError: true,
    };
  }
  const projectedTotal = totalBytes(existing) + fileStat.size;
  if (projectedTotal > maxTotalAttachmentBytes) {
    return {
      content:
        `email_attach: total queued size would exceed cap ` +
        `(${(projectedTotal / 1024 / 1024).toFixed(1)} MB > ${maxTotalAttachmentBytes / 1024 / 1024} MB). ` +
        `Already queued: ${(totalBytes(existing) / 1024 / 1024).toFixed(1)} MB across ${existing.length} file(s).`,
      isError: true,
    };
  }

  let content: Buffer;
  try {
    content = await readFile(resolved);
  } catch (err) {
    const msg = formatErrorMessage(err);
    return { content: `email_attach: failed to read '${path}': ${msg}`, isError: true };
  }

  // Defense-in-depth against the prompt-injection-into-exfil chain:
  // even when a file slips past the sensitive-filename blocklist
  // (e.g. credentials copied into notes.txt), scan the bytes for known
  // secret shapes before queuing. Binary attachments skip the scan —
  // false positives from PDFs/images would block legitimate sends, and
  // a credential lifted into a binary blob is several layers of
  // deliberate maneuvering past where prompt injection lives.
  if (looksLikeText(content)) {
    const asText = content.toString("utf-8");
    const { leaks } = redactToolResultSecrets(asText);
    if (leaks.length > 0) {
      const labels = [...new Set(leaks.map((l) => l.label))];
      logger.warn(
        {
          sessionKey,
          sourcePath: resolved,
          leakLabels: labels,
          leakCount: leaks.length,
        },
        "email_attach: refusing to attach — file contains likely credentials",
      );
      return {
        content:
          `email_attach: refused — '${path}' appears to contain credentials ` +
          `(matched: ${labels.join(", ")}). If you need to share this file, ` +
          `redact the sensitive lines first or send a sanitized copy.`,
        isError: true,
      };
    }
  }

  const filename = sanitizeFilename(filenameOverride ?? basename(resolved));
  const contentType = guessContentType(filename);

  const queued: QueuedAttachment = {
    filename,
    content,
    contentType,
    sourcePath: resolved,
  };

  if (!queues.has(sessionKey)) ensureCapacity();
  touchSession(sessionKey);
  const list = getQueue(sessionKey);
  list.push(queued);
  queues.set(sessionKey, list);

  const newTotal = totalBytes(list);
  logger.info(
    {
      sessionKey,
      filename,
      sourcePath: resolved,
      bytes: content.length,
      queuedCount: list.length,
      queuedTotalBytes: newTotal,
    },
    "email_attach: file queued for next reply",
  );

  const sizeKb = (content.length / 1024).toFixed(1);
  const totalKb = (newTotal / 1024).toFixed(1);
  return {
    content:
      `Attached ${filename} (${sizeKb} KB) — queued for next reply. ` +
      `Queue: ${list.length}/${MAX_ATTACHMENTS_PER_SESSION} files, ${totalKb} KB total. ` +
      `Files in this queue are sent automatically when your reply is delivered.`,
    outputs: {
      filename,
      bytes: content.length,
      contentType: contentType ?? "application/octet-stream",
      queuedCount: list.length,
      queuedTotalBytes: newTotal,
    },
  };
}

/**
 * email_attach_content — author a file in the workspace AND stage it for the
 * next reply in a single call.
 *
 * Motivation: the two-step flow (file_write → email_attach) is error-prone
 * for smaller models — if they skip file_write, email_attach errors on a
 * non-existent path, and the model can end up narrating success for a file
 * that was never produced (the 2026-04-24 "AI_Cybersecurity_Report_2026.md"
 * incident). A composite tool removes the orchestration requirement: the
 * model picks one tool, passes a filename + content, and the write+queue
 * happens atomically.
 *
 * This is NOT a replacement for email_attach — use email_attach when the
 * file already exists on disk (user uploaded it, earlier turn produced it,
 * etc.). Use email_attach_content for content you are authoring right now.
 *
 * Effect class: write (it writes to disk). All the same caps as email_attach
 * apply, and the same queue is used — drainAttachments returns items from
 * both tools indistinguishably.
 *
 * Name collisions are refused, not overwritten: the tool is "create and
 * attach" — if a file with that name already exists, that is a signal the
 * caller should pick a different name or explicitly use file_write +
 * email_attach to opt into overwrite.
 */
async function handleEmailAttachContent(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ content: string; isError?: boolean; outputs?: Record<string, unknown> }> {
  if (!context?.sessionKey) {
    return {
      content: "email_attach_content is only available inside an active session.",
      isError: true,
    };
  }
  const sessionKey = context.sessionKey;

  const rawFilename = typeof params.filename === "string" ? params.filename.trim() : "";
  if (!rawFilename) {
    return {
      content: "email_attach_content: 'filename' is required (leaf name only, e.g. 'report.md' — no path separators).",
      isError: true,
    };
  }

  // Must be a leaf name — no path separators. If the model wants to write
  // to a subdirectory, it should use file_write + email_attach explicitly.
  if (rawFilename.includes("/") || rawFilename.includes("\\")) {
    return {
      content:
        "email_attach_content: 'filename' must be a leaf name (e.g. 'report.md'), not a path. " +
        "To attach a file at a specific subdirectory, use file_write followed by email_attach.",
      isError: true,
    };
  }

  if (typeof params.content !== "string") {
    return {
      content: "email_attach_content: 'content' is required and must be a string (the full file body, text only).",
      isError: true,
    };
  }
  const rawContent: string = params.content;
  if (rawContent.length === 0) {
    return {
      content: "email_attach_content: 'content' is empty; refusing to attach an empty file.",
      isError: true,
    };
  }

  const filename = sanitizeFilename(rawFilename);

  // Scan the LLM-authored content for credential shapes before we
  // materialize it on disk. email_attach_content is the path where the
  // model directly hands us bytes to send out — if those bytes carry
  // an API key (hallucinated, recalled, or smuggled via base64), this
  // is where it leaves the box. The redact step also covers base64
  // re-encoded secrets via sanitize.ts's scanBase64 pass.
  {
    const { leaks } = redactToolResultSecrets(rawContent);
    if (leaks.length > 0) {
      const labels = [...new Set(leaks.map((l) => l.label))];
      logger.warn(
        {
          sessionKey,
          filename,
          leakLabels: labels,
          leakCount: leaks.length,
        },
        "email_attach_content: refusing to author — supplied content contains likely credentials",
      );
      return {
        content:
          `email_attach_content: refused — the supplied content appears to ` +
          `contain credentials (matched: ${labels.join(", ")}). Send a ` +
          `sanitized version, or use file_write + email_attach explicitly ` +
          `if you have already redacted the sensitive lines.`,
        isError: true,
      };
    }
  }

  const buffer = Buffer.from(rawContent, "utf-8");

  if (buffer.length > maxAttachmentBytes) {
    return {
      content:
        `email_attach_content: content is too large ` +
        `(${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${maxAttachmentBytes / 1024 / 1024} MB per-file cap).`,
      isError: true,
    };
  }

  const existing = getQueue(sessionKey);
  if (existing.length >= MAX_ATTACHMENTS_PER_SESSION) {
    return {
      content:
        `email_attach_content: queue full — already ${existing.length}/${MAX_ATTACHMENTS_PER_SESSION} attachments staged. ` +
        `Send the current reply first, or reduce the number of files.`,
      isError: true,
    };
  }
  const projectedTotal = totalBytes(existing) + buffer.length;
  if (projectedTotal > maxTotalAttachmentBytes) {
    return {
      content:
        `email_attach_content: total queued size would exceed cap ` +
        `(${(projectedTotal / 1024 / 1024).toFixed(1)} MB > ${maxTotalAttachmentBytes / 1024 / 1024} MB). ` +
        `Already queued: ${(totalBytes(existing) / 1024 / 1024).toFixed(1)} MB across ${existing.length} file(s).`,
      isError: true,
    };
  }

  const resolved = await jailPathReal(filename);
  if (!resolved) {
    return {
      content: `email_attach_content: ${jailDenialMessage(filename)}`,
      isError: true,
    };
  }

  // Refuse to clobber an existing file. The atomic tool's contract is
  // "create and attach" — an existing file at this name is a signal the
  // caller should pick a different name or drop to file_write + email_attach.
  try {
    const prior = await stat(resolved);
    if (prior.isFile() || prior.isDirectory()) {
      return {
        content:
          `email_attach_content: '${filename}' already exists in the workspace. ` +
          `Pick a different filename, or use file_write (with overwrite:true) followed by email_attach if you need to replace it.`,
        isError: true,
      };
    }
  } catch {
    // ENOENT is the happy path — file doesn't exist yet, proceed to write.
  }

  // Atomic write: write to a sibling .tmp file, then rename into place.
  // This prevents partial-file observability if the process dies mid-write.
  const tmpPath = `${resolved}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, resolved);
  } catch (err) {
    // Best-effort cleanup of the tmp file on failure.
    try { await unlink(tmpPath); } catch { /* best effort */ }
    const msg = formatErrorMessage(err);
    return {
      content: `email_attach_content: failed to write '${filename}': ${msg}`,
      isError: true,
    };
  }

  const contentType = guessContentType(filename);
  const queued: QueuedAttachment = {
    filename,
    content: buffer,
    contentType,
    sourcePath: resolved,
  };

  if (!queues.has(sessionKey)) ensureCapacity();
  touchSession(sessionKey);
  const list = getQueue(sessionKey);
  list.push(queued);
  queues.set(sessionKey, list);

  const newTotal = totalBytes(list);
  logger.info(
    {
      sessionKey,
      filename,
      sourcePath: resolved,
      bytes: buffer.length,
      queuedCount: list.length,
      queuedTotalBytes: newTotal,
    },
    "email_attach_content: file authored and queued for next reply",
  );

  const sizeKb = (buffer.length / 1024).toFixed(1);
  const totalKb = (newTotal / 1024).toFixed(1);
  return {
    content:
      `Wrote ${filename} (${sizeKb} KB) to the workspace and queued it as an attachment on the next reply. ` +
      `Queue: ${list.length}/${MAX_ATTACHMENTS_PER_SESSION} files, ${totalKb} KB total.`,
    outputs: {
      filename,
      bytes: buffer.length,
      contentType: contentType ?? "application/octet-stream",
      queuedCount: list.length,
      queuedTotalBytes: newTotal,
      sourcePath: resolved,
    },
  };
}

export function registerEmailAttachTool(): void {
  registerToolHandler("email_attach", handleEmailAttach);
  registerToolHandler("email_attach_content", handleEmailAttachContent);
  logger.info(
    { tools: ["email_attach", "email_attach_content"] },
    "email_attach tools registered",
  );
}
