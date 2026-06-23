// cortexDream — the brain-maintenance engine.
//
// Runs at the end of turns (fire-and-forget from the after_turn site
// in inference.ts) and, if all gates pass, performs a maintenance
// pass over the memory system: sweeping loose memdir entries,
// filing them away, reflecting on recent or random engrams, and
// (eventually) promoting them between tiers (STM → LTM → core).
//
// The name is deliberate: this is not "autosave" or "consolidation"
// in the narrow sense. It's the cortex resting — the quiet pass
// where the brain cleans up, strengthens what mattered, and lets
// go of what didn't. The framing matters because later passes will
// include random-recall reflection, stale-engram pruning, and
// tier promotion across the .shard mindshard system.
//
// The consolidator itself is currently a STUB: it rebuilds MEMORY.md
// by running the memdir manifest through a deterministic formatter.
// No LLM. Tier promotion (cortex-tiers.ts) is present as scaffolding
// but not yet wired into the run path — it's portable code other
// shard projects can lift without taking the whole runtime. The
// spine around the stub (gates, lock, scan, write) is production-
// ready and survives intact as we swap bodies in.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  scanMemdir,
  readEntrypoint,
  writeEntrypoint,
  measureEntrypoint,
  formatManifest,
  type MemdirHeader,
} from "./memdir.js";
import {
  acquireLock,
  releaseLock,
  readLastConsolidatedMs,
} from "./cortexdream-lock.js";

export interface CortexDreamConfig {
  enabled: boolean;
  /** Memory directory (absolute or workspace-relative). */
  memoryDir: string;
  /** Minimum hours between successful runs. Default 24. */
  minHoursBetweenRuns: number;
  /** Minimum distinct sessions observed since last run. Default 5. */
  minSessionsBetweenRuns: number;
  /** How long to wait between gate attempts in the same process. Default 10 min. */
  throttleMs: number;
  /** Lock is considered stale after this many ms. Default 60 min. */
  lockStaleMs: number;
  /** Directory where session files live (for the session-count gate). */
  sessionsDir: string;
}

export const DEFAULT_CORTEX_CONFIG: Readonly<CortexDreamConfig> = {
  enabled: false,
  memoryDir: ".crabmeat/memory",
  minHoursBetweenRuns: 24,
  minSessionsBetweenRuns: 5,
  throttleMs: 10 * 60 * 1000,
  lockStaleMs: 60 * 60 * 1000,
  sessionsDir: ".crabmeat/sessions",
};

export type GateOutcome =
  | { ok: true }
  | { ok: false; stage: string; reason: string };

export interface DreamRunResult {
  ran: boolean;
  /** If ran=false, why. */
  reason?: string;
  /** If ran=true, counters from the run. */
  summary?: {
    filesScanned: number;
    entrypointBytesBefore: number;
    entrypointBytesAfter: number;
    durationMs: number;
  };
}

// Per-process state: the last time we attempted a gate check for a
// given memory dir. Used for the throttle gate (gate 3) so we don't
// stat the sessions dir on every turn.
const lastGateAttemptMs = new Map<string, number>();

// Per-process "is a run in flight" flag, keyed on memory dir. Guards
// against reentry from a concurrent fire-and-forget. The file lock
// guards cross-process contention; this flag guards same-process
// reentry which the file lock would also catch but with a less
// informative reason.
const runningFor = new Set<string>();

/**
 * Count sessions that have been touched since the given timestamp.
 * A "session" is a file in `sessionsDir` whose mtime is newer than
 * `sinceMs`. Cheap: just reads directory entries and stats each.
 * `currentSessionKey`, if provided, is excluded so the gate does
 * not count the session that triggered the check.
 */
export async function countRecentSessions(
  sessionsDir: string,
  sinceMs: number,
  currentSessionKey?: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let count = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    // Session files are typically `<key>.json` — ignore the current
    // session by prefix match so both `.json` and `.json.tmp` skip.
    if (currentSessionKey && name.startsWith(currentSessionKey)) continue;
    try {
      const st = await stat(join(sessionsDir, name));
      if (!st.isFile()) continue;
      if (st.mtimeMs > sinceMs) count += 1;
    } catch {
      // best-effort
    }
  }
  return count;
}

/**
 * Run the 5-gate check against live state. Returns the first
 * failing gate or `{ ok: true }`. Gate ordering is cheapest-first:
 *
 *   Gate 0 — config enabled
 *   Gate 1 — per-process throttle (don't re-gate every turn)
 *   Gate 2 — time since last successful consolidation
 *   Gate 3 — per-process "not already running"
 *   Gate 4 — session count since last run
 *
 * Gate 5 (the file lock) is not checked here — the caller tries to
 * acquire it after all content gates pass, and the lock result is
 * folded into the final verdict.
 */
export async function checkGates(
  cfg: CortexDreamConfig,
  opts: { currentSessionKey?: string; nowMs?: number } = {},
): Promise<GateOutcome> {
  const now = opts.nowMs ?? Date.now();

  if (!cfg.enabled) {
    return { ok: false, stage: "enabled", reason: "cortexDream disabled by config" };
  }

  if (runningFor.has(cfg.memoryDir)) {
    return { ok: false, stage: "reentry", reason: "run already in progress for this memory dir" };
  }

  const lastAttempt = lastGateAttemptMs.get(cfg.memoryDir) ?? 0;
  if (now - lastAttempt < cfg.throttleMs) {
    return {
      ok: false,
      stage: "throttle",
      reason: `gate checked ${Math.round((now - lastAttempt) / 1000)}s ago — under throttle of ${Math.round(cfg.throttleMs / 1000)}s`,
    };
  }
  lastGateAttemptMs.set(cfg.memoryDir, now);

  const lastConsolidatedMs = await readLastConsolidatedMs(cfg.memoryDir);
  const hoursElapsed = (now - lastConsolidatedMs) / (60 * 60 * 1000);
  if (lastConsolidatedMs > 0 && hoursElapsed < cfg.minHoursBetweenRuns) {
    return {
      ok: false,
      stage: "time",
      reason: `last consolidation ${hoursElapsed.toFixed(1)}h ago — need ${cfg.minHoursBetweenRuns}h`,
    };
  }

  const sessions = await countRecentSessions(
    cfg.sessionsDir,
    lastConsolidatedMs,
    opts.currentSessionKey,
  );
  if (sessions < cfg.minSessionsBetweenRuns) {
    return {
      ok: false,
      stage: "sessions",
      reason: `${sessions} sessions since last run — need ${cfg.minSessionsBetweenRuns}`,
    };
  }

  return { ok: true };
}

/**
 * v0 STUB consolidator. Rebuilds MEMORY.md as a deterministic index
 * over the memdir headers, keeping the structure that future LLM
 * versions will target. Deliberately idempotent and side-effect-
 * free beyond the single entrypoint write — no file deletes, no
 * content mutation on individual memory files.
 *
 * When we swap this for an LLM version, the signature stays the
 * same so the caller (`runCortexDreamIfDue`) does not change.
 */
export async function runConsolidator(
  cfg: CortexDreamConfig,
  headers: readonly MemdirHeader[],
): Promise<{ newEntrypoint: string }> {
  const existing = (await readEntrypoint(cfg.memoryDir)) ?? "";
  const header =
    "# MEMORY index\n\n" +
    "> Auto-generated by cortexDream stub consolidator. " +
    "Semantic dedup, reflection, and tier promotion will replace this when the LLM-backed consolidator ships. " +
    "Manual edits below this line are preserved across runs.\n\n";
  const manifest = formatManifest(headers);
  const stubBody = `${header}## Auto-generated manifest (${new Date().toISOString()})\n\n${manifest}\n`;

  // Preserve any user content below a sentinel so manual edits
  // survive consolidation runs. First run writes the sentinel;
  // subsequent runs only rewrite the region above it.
  const SENTINEL = "\n<!-- cortexdream:manifest-end -->\n";
  let preservedTail = "";
  const sentinelIdx = existing.indexOf(SENTINEL);
  if (sentinelIdx >= 0) {
    preservedTail = existing.slice(sentinelIdx + SENTINEL.length);
  }

  return { newEntrypoint: stubBody + SENTINEL + preservedTail };
}

/**
 * Top-level orchestrator. Fires from the after_turn site. Always
 * returns — never throws — so a failure in the consolidator can
 * never fail a user turn.
 *
 * Shape:
 *   1. Run content gates
 *   2. Acquire lock (gate 5)
 *   3. Scan memdir
 *   4. Run consolidator (currently stub)
 *   5. Write entrypoint + release lock with recordConsolidation=true
 *   6. On any error in 3-5, release with recordConsolidation=false
 */
export async function runCortexDreamIfDue(
  cfg: CortexDreamConfig,
  opts: { currentSessionKey?: string } = {},
): Promise<DreamRunResult> {
  const gate = await checkGates(cfg, opts);
  if (!gate.ok) {
    // Log at debug — gate rejections are the common path, and
    // info-level would drown the session start log.
    logger.debug({ stage: gate.stage, reason: gate.reason }, "cortexDream: gate closed");
    return { ran: false, reason: `${gate.stage}: ${gate.reason}` };
  }

  runningFor.add(cfg.memoryDir);
  const started = Date.now();
  let locked = false;
  let priorMtimeMs = 0;

  try {
    const lockResult = await acquireLock(cfg.memoryDir, cfg.lockStaleMs);
    if (!lockResult.acquired) {
      logger.info(
        { reason: lockResult.reason, heldBy: lockResult.heldByPid },
        "cortexDream: lock busy",
      );
      return { ran: false, reason: `lock: ${lockResult.reason ?? "busy"}` };
    }
    locked = true;
    priorMtimeMs = lockResult.priorMtimeMs;

    const headers = await scanMemdir(cfg.memoryDir);
    const existingEntrypoint = (await readEntrypoint(cfg.memoryDir)) ?? "";
    const entrypointBytesBefore = Buffer.byteLength(existingEntrypoint, "utf-8");

    const { newEntrypoint } = await runConsolidator(cfg, headers);
    const report = measureEntrypoint(newEntrypoint);
    await writeEntrypoint(cfg.memoryDir, newEntrypoint);

    logger.info(
      {
        filesScanned: headers.length,
        entrypointBytesBefore,
        entrypointBytesAfter: report.bytes,
        entrypointLines: report.lines,
        overCap: report.overLineCap || report.overByteCap,
      },
      "cortexDream: consolidation complete",
    );

    return {
      ran: true,
      summary: {
        filesScanned: headers.length,
        entrypointBytesBefore,
        entrypointBytesAfter: report.bytes,
        durationMs: Date.now() - started,
      },
    };
  } catch (err) {
    logger.error(
      { error: formatErrorMessage(err) },
      "cortexDream: consolidation failed — rolling back",
    );
    if (locked) {
      await releaseLock(cfg.memoryDir, {
        recordConsolidation: false,
        priorMtimeMs,
      });
      locked = false;
    }
    return { ran: false, reason: "consolidator threw" };
  } finally {
    if (locked) {
      await releaseLock(cfg.memoryDir, {
        recordConsolidation: true,
        priorMtimeMs,
      });
    }
    runningFor.delete(cfg.memoryDir);
  }
}

/**
 * Test-only: reset the per-process state so successive test cases
 * don't bleed throttle/reentry flags into each other.
 */
export function __resetCortexDreamProcessState(): void {
  lastGateAttemptMs.clear();
  runningFor.clear();
}
