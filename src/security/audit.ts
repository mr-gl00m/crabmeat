import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeJsonAtomic } from "../infra/fs.js";
import { redactLeaks } from "./sanitize.js";
import { diagnostics } from "../infra/diagnostics/index.js";

export interface AuditEntry {
  seq: number;
  timestamp: string;
  sessionKey: string;
  toolId: string;
  toolName: string;
  effectClass: string;
  callId: string;
  parameters: Record<string, unknown>;
  resultStatus: "success" | "error" | "denied";
  durationMs: number;
  hash: string;
  prevHash: string;
  /**
   * Trust role of the caller for this invocation. "owner" / "shell" /
   * "external". Optional so old persisted entries (written before the
   * field existed) load and re-verify cleanly — JSON.stringify drops
   * undefined keys, so an absent callerRole produces the same hash as
   * before.
   */
  callerRole?: string;
  /**
   * Set when the resolved tool was owner-only. Surfaces forensic intent
   * even on denied/successful invocations: an owner-only tool that
   * resolved despite a non-owner role would point to a routing bug.
   */
  ownerOnly?: boolean;
}

/**
 * Operational health snapshot for the audit log. Surfaces enough state
 * for /doctor and a future /admin/status endpoint to detect "audit
 * persistence has been failing for N minutes" without grepping logs.
 *
 * For a security tool where audit completeness is part of the value
 * proposition, silent disk-flush failures are a credibility gap — this
 * shape is what closes it.
 */
export interface AuditStatus {
  /** True when persistDir is configured and disk flushes are happening. */
  persistEnabled: boolean;
  /** Number of entries currently buffered in memory awaiting flush. */
  pendingWrites: number;
  /** Total entries currently held in the in-memory ring (post-rotation). */
  totalEntries: number;
  /** ISO timestamp of the most recent flush attempt; null if never flushed. */
  lastFlushAt: string | null;
  /**
   * true  = last flush succeeded
   * false = last flush failed (see lastFlushError)
   * null  = no flush has been attempted yet (cold start)
   */
  lastFlushOk: boolean | null;
  /** Error message from the most recent failed flush; null on success. */
  lastFlushError: string | null;
}

export interface AuditLog {
  record(
    entry: Omit<AuditEntry, "seq" | "hash" | "prevHash">,
  ): AuditEntry;
  verify(): { valid: boolean; brokenAt?: number };
  getEntries(sessionKey?: string): ReadonlyArray<AuditEntry>;
  /** Flush pending entries to disk. Called automatically, but can be forced. */
  flush(): Promise<void>;
  /** Operational health surface. Safe to call from /doctor / monitoring. */
  getStatus(): AuditStatus;
  readonly length: number;
}

export interface AuditLogOptions {
  maxEntries?: number;
  /** Directory for audit log persistence. If unset, logs are in-memory only. */
  persistDir?: string;
  /** How many entries to buffer before flushing to disk. Default: 10. */
  flushThreshold?: number;
}

export function createAuditLog(opts: AuditLogOptions | number = 10_000): AuditLog {
  // Support legacy call signature: createAuditLog(maxEntries)
  const options: AuditLogOptions = typeof opts === "number" ? { maxEntries: opts } : opts;
  const maxEntries = options.maxEntries ?? 10_000;
  const persistDir = options.persistDir;
  const flushThreshold = options.flushThreshold ?? 10;

  const entries: AuditEntry[] = [];
  const pendingWrites: AuditEntry[] = [];
  let flushPromise: Promise<void> | null = null;
  let dirReady = false;
  // Flush-state tracking. lastFlushAt updates on every attempt (success
  // or failure); lastFlushOk records the outcome; lastFlushError keeps
  // the most recent failure message. All three start null at cold start
  // — getStatus() consumers (e.g. /doctor) treat null lastFlushOk as
  // "no flush attempted yet" rather than a failure.
  let lastFlushAt: string | null = null;
  let lastFlushOk: boolean | null = null;
  let lastFlushError: string | null = null;

  function computeHash(
    entry: Omit<AuditEntry, "hash">,
    prevHash: string,
  ): string {
    // callerRole / ownerOnly are conditionally serialized: undefined keys
    // are dropped by JSON.stringify, so pre-Phase-4.11 entries (which had
    // no such field) re-verify with the same hash they were sealed with.
    const payload = JSON.stringify({
      seq: entry.seq,
      timestamp: entry.timestamp,
      sessionKey: entry.sessionKey,
      toolId: entry.toolId,
      effectClass: entry.effectClass,
      callId: entry.callId,
      resultStatus: entry.resultStatus,
      callerRole: entry.callerRole,
      ownerOnly: entry.ownerOnly,
      prevHash,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  function maskParameters(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") {
        masked[key] = redactLeaks(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  async function ensurePersistDir(): Promise<void> {
    if (!persistDir || dirReady) return;
    await mkdir(persistDir, { recursive: true });
    dirReady = true;
  }

  /** Append buffered entries to the JSONL audit file on disk. */
  async function flushToDisk(): Promise<void> {
    if (!persistDir || pendingWrites.length === 0) return;
    await ensurePersistDir();
    const lines = pendingWrites.map((e) => JSON.stringify(e)).join("\n") + "\n";
    pendingWrites.length = 0;
    const logPath = join(persistDir, "audit.jsonl");
    await appendFile(logPath, lines, "utf-8");
  }

  /** Write a signed snapshot of the current chain state. */
  async function writeSnapshot(): Promise<void> {
    if (!persistDir) return;
    await ensurePersistDir();
    const lastEntry = entries[entries.length - 1];
    const snapshot = {
      timestamp: new Date().toISOString(),
      entryCount: entries.length,
      lastSeq: lastEntry?.seq ?? -1,
      lastHash: lastEntry?.hash ?? "GENESIS",
      // Integrity signature: hash of the snapshot content itself
      checksum: "",
    };
    snapshot.checksum = createHash("sha256")
      .update(JSON.stringify({ ...snapshot, checksum: undefined }))
      .digest("hex");

    await writeJsonAtomic(join(persistDir, "audit-snapshot.json"), snapshot);
  }

  return {
    get length() {
      return entries.length;
    },

    record(partial) {
      // Rotate if at capacity
      if (entries.length >= maxEntries) {
        entries.shift();
      }

      const seq = entries.length > 0 ? entries[entries.length - 1]!.seq + 1 : 0;
      const prevHash =
        entries.length > 0 ? entries[entries.length - 1]!.hash : "GENESIS";

      const entry: AuditEntry = {
        ...partial,
        parameters: maskParameters(partial.parameters),
        seq,
        prevHash,
        hash: "",
      };
      entry.hash = computeHash(entry, prevHash);
      entries.push(entry);

      diagnostics.emit("audit.recorded", {
        auditSeq: entry.seq,
        sessionKey: entry.sessionKey,
        toolId: entry.toolId,
        toolName: entry.toolName,
        effectClass: entry.effectClass,
        resultStatus: entry.resultStatus,
        durationMs: entry.durationMs,
      });

      logger.info(
        {
          seq: entry.seq,
          toolId: entry.toolId,
          sessionKey: entry.sessionKey,
          resultStatus: entry.resultStatus,
        },
        "Audit entry recorded",
      );

      // Queue for disk persistence
      if (persistDir) {
        pendingWrites.push(entry);
        if (pendingWrites.length >= flushThreshold && !flushPromise) {
          flushPromise = flushToDisk()
            .then(() => writeSnapshot())
            .then(() => {
              lastFlushAt = new Date().toISOString();
              lastFlushOk = true;
              lastFlushError = null;
            })
            .catch((err) => {
              lastFlushAt = new Date().toISOString();
              lastFlushOk = false;
              lastFlushError = formatErrorMessage(err);
              logger.error(
                { error: lastFlushError },
                "Audit log disk flush failed — entries retained in memory",
              );
            })
            .finally(() => { flushPromise = null; });
        }
      }

      return entry;
    },

    verify() {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const expectedPrev =
          i === 0 ? entries[0]!.prevHash : entries[i - 1]!.hash;
        if (entry.prevHash !== expectedPrev) {
          return { valid: false, brokenAt: entry.seq };
        }
        const recomputed = computeHash(entry, entry.prevHash);
        if (recomputed !== entry.hash) {
          return { valid: false, brokenAt: entry.seq };
        }
      }
      return { valid: true };
    },

    getEntries(sessionKey?: string) {
      if (sessionKey) return entries.filter((e) => e.sessionKey === sessionKey);
      return [...entries];
    },

    async flush() {
      if (flushPromise) await flushPromise;
      // Explicit flush() runs regardless of persistDir; flushToDisk and
      // writeSnapshot are no-ops when persist is off, so the only state
      // change in that case is leaving lastFlush* untouched.
      if (!persistDir) return;
      try {
        await flushToDisk();
        await writeSnapshot();
        lastFlushAt = new Date().toISOString();
        lastFlushOk = true;
        lastFlushError = null;
      } catch (err) {
        lastFlushAt = new Date().toISOString();
        lastFlushOk = false;
        lastFlushError = formatErrorMessage(err);
        // Re-throw so the caller (test harness, /admin/audit/flush in a
        // future track) sees the failure. The auto-flush path above
        // intentionally swallows because it runs in the background.
        throw err;
      }
    },

    getStatus() {
      return {
        persistEnabled: Boolean(persistDir),
        pendingWrites: pendingWrites.length,
        totalEntries: entries.length,
        lastFlushAt,
        lastFlushOk,
        lastFlushError,
      };
    },
  };
}
