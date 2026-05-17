import { pino } from "pino";
import { mkdirSync, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadEnv } from "./env.js";
import { redactLeaks } from "../security/sanitize.js";
import { formatErrorMessage } from "./errors.js";

/**
 * Hash a sessionKey for safe inclusion in logs. Returns a 12-hex-char SHA-256
 * prefix tagged `sk:` so log readers can still correlate entries within a
 * single session without exposing the raw key.
 *
 * Why hash at all: sessionKey is derived deterministically (e.g. for the
 * email connector, `inbound:${connectorId}:${sender}`), so a raw key in a
 * log file shared in a bug report or screenshot is recoverable to the
 * underlying sender. The hash is a one-way correlation token.
 *
 * Exported so call sites that build their own structured fields (or want
 * the same correlation token in user-facing diagnostics) can use it directly.
 * The pino redactor below applies it automatically to common field names.
 */
export function hashSessionKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "sk:none";
  return "sk:" + createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Per-run log file path. Resolved once at module import so every log line
 * during a single server run lands in the same file. Format:
 *   .crabmeat/logs/run-2026-04-13T21-46-54.log
 *
 * Created lazily via createRunLogStream() so tests (which import the
 * logger transitively) don't litter the workspace with stub log files.
 * Set CRABMEAT_LOG_FILE=0 to disable file logging entirely; set it to an
 * absolute path to override the default location.
 */
let runLogPath: string | undefined;

export function getRunLogPath(): string | undefined {
  return runLogPath;
}

function createRunLogStream(): NodeJS.WritableStream | undefined {
  // Skip when running under vitest — we don't want test runs writing
  // files to .crabmeat/logs/. VITEST is set automatically by the runner.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return undefined;
  if (process.env.CRABMEAT_LOG_FILE === "0") return undefined;

  try {
    if (process.env.CRABMEAT_LOG_FILE && process.env.CRABMEAT_LOG_FILE !== "1") {
      runLogPath = process.env.CRABMEAT_LOG_FILE;
    } else {
      // Filesystem-safe ISO timestamp: 2026-04-13T21-46-54-123Z
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = join(process.cwd(), ".crabmeat", "logs");
      mkdirSync(dir, { recursive: true });
      runLogPath = join(dir, `run-${stamp}.log`);
    }
    // append flag in case the user reuses a path or restarts within the
    // same second (rare, but safe)
    return createWriteStream(runLogPath, { flags: "a" });
  } catch (err) {
    // Fall back silently to stdout-only — file logging is a convenience,
    // not a hard requirement, and a failed mkdir shouldn't crash startup.
    process.stderr.write(
      `crabmeat: failed to create run log file: ${formatErrorMessage(err)}\n`,
    );
    runLogPath = undefined;
    return undefined;
  }
}

/**
 * Pino redact config that automatically hashes any field literally named
 * `sessionKey` or `parentSessionKey` at depth 1 or 2 of the log object
 * (i.e. `{sessionKey: ...}`, `{err, sessionKey}`, `{route: {sessionKey: ...}}`).
 *
 * Most call sites in this codebase log sessionKey at depth 1 of the merging
 * object — e.g. `logger.info({sessionKey, ...}, "msg")`. The depth-2 wildcard
 * covers nested-object cases without forcing every call site to flatten.
 *
 * censor returns the hashed token via hashSessionKey() so a single helper
 * is the only place this redaction format lives.
 */
const REDACT_PATHS = [
  "sessionKey",
  "parentSessionKey",
  "*.sessionKey",
  "*.parentSessionKey",
];

function censorSessionKey(value: unknown): string {
  return hashSessionKey(value);
}

/**
 * Walk a log object and run every string leaf through redactLeaks(skipBase64).
 *
 * Why this exists at the formatter layer: many call sites log tool params
 * verbatim — e.g. `logger.info({uid, subject: trimmedSubject}, "...")` in
 * the email connector. Tool *outputs* already get redacted at invoke.ts,
 * but tool *inputs* and arbitrary user-controlled fields (subject lines,
 * shell args, file paths) routinely contain credential-shaped tokens, and
 * we'd otherwise need to remember to wrap every call site individually —
 * a perpetual game of whack-a-mole. Centralizing here means new call
 * sites are protected by default.
 *
 * Cost note: redactLeaks runs ~12 cheap regexes per string. We skip the
 * base64 sub-scan in the logger path because it triples runtime and the
 * scenarios it catches (someone deliberately base64-wrapping a secret
 * before printing it) almost never apply to internal log messages.
 *
 * Depth bounded to LEAF_DEPTH_LIMIT to defend against pathological cyclic
 * objects — pino itself has its own cycle handling but we walk first, so
 * the cap also guards against accidental log-of-massive-config bloat.
 */
const LEAF_DEPTH_LIMIT = 6;
const LEAF_STRING_MIN_LEN = 8;

function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > LEAF_DEPTH_LIMIT) return v;
    if (typeof v === "string") {
      // Cheap length gate: nothing in SENSITIVE_PATTERNS matches under
      // 8 chars (the shortest patterns are AKIA + 16 hex = 20 chars,
      // sk- + 20 chars = 23 chars, etc.). Skipping short strings is a
      // big runtime win on log objects full of identifiers and labels.
      if (v.length < LEAF_STRING_MIN_LEN) return v;
      return redactLeaks(v, undefined, { skipBase64: true });
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (v !== null && typeof v === "object") {
      // Bail on Error instances — pino has its own serializer and our
      // walk would clobber the stack trace. The serializer's own output
      // gets re-fed through this formatter at the next level.
      if (v instanceof Error) return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(obj, 0) as Record<string, unknown>;
}

export function createLogger(name?: string): pino.Logger {
  const env = loadEnv();
  const fileStream = createRunLogStream();

  // multistream when we have a file destination, otherwise plain stdout.
  // Both streams get the same JSONL output — the file is just a copy
  // for after-the-fact review during testing.
  if (fileStream) {
    return pino(
      {
        name: name ?? "crabmeat",
        level: env.LOG_LEVEL,
        redact: { paths: REDACT_PATHS, censor: censorSessionKey },
        formatters: { log: redactLogObject },
      },
      pino.multistream([
        { stream: process.stdout },
        { stream: fileStream },
      ]),
    );
  }

  return pino({
    name: name ?? "crabmeat",
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: censorSessionKey },
    formatters: { log: redactLogObject },
    ...(env.NODE_ENV === "development" && {
      transport: {
        target: "pino/file",
        options: { destination: 1 },
      },
    }),
  });
}

export const logger = createLogger();

if (runLogPath) {
  logger.info({ runLogPath }, "Per-run log file created");
}
