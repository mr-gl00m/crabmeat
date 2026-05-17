// cortexDream consolidation lock. Per-memdir file mutex:
//
//   - Lock file body = holder PID
//   - Lock file mtime = `lastConsolidatedAt` (so acquire/release bump
//     the mtime, and the gate check reads it directly)
//   - Stale if mtime older than `staleMs` OR PID not running
//   - Reclaim-on-acquire races are guarded by re-reading the body
//     after writing; whoever's PID sticks owns the lock
//
// Per-workspace, not per-user: keyed by the memdir path. Two
// processes operating on different workspaces do not contend.
//
// Lock scope today is per-memdir. Shard-level locking (for concurrent
// .shard mindshard writes across multiple Rifts) is a follow-up —
// this module is the reusable mutex primitive either scope can sit on.

import { readFile, writeFile, stat, utimes, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";

const LOCK_FILE_NAME = ".cortexdream-lock";

export interface LockAcquireResult {
  /** True if this process owns the lock after the call. */
  acquired: boolean;
  /** The mtime of the lock file *before* this call — i.e. the last
   * successful consolidation time. Epoch 0 if the lock did not exist. */
  priorMtimeMs: number;
  /** PID currently holding the lock, if not us. Only set when `acquired=false`. */
  heldByPid?: number;
  /** Human-readable reason for failure, if any. */
  reason?: string;
}

function lockPath(memoryDir: string): string {
  return join(memoryDir, LOCK_FILE_NAME);
}

async function readLockContent(path: string): Promise<
  { pid: number; mtimeMs: number } | undefined
> {
  try {
    const [body, st] = await Promise.all([
      readFile(path, "utf-8"),
      stat(path),
    ]);
    const pid = Number.parseInt(body.trim(), 10);
    if (!Number.isFinite(pid)) return undefined;
    return { pid, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Best-effort check: is the process with this PID still alive? On
 * Windows and POSIX, `process.kill(pid, 0)` throws ESRCH for dead
 * PIDs and EPERM for live-but-not-ours. Both ENOENT and EPERM are
 * treated as "still alive" — we err on the side of not stomping
 * another process's lock. ESRCH is the only "definitely dead"
 * verdict.
 */
export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: process exists but not ours to signal → still alive.
    return true;
  }
}

/**
 * Read the last consolidation timestamp without acquiring the lock.
 * Used by the gate check to decide whether to even attempt acquire —
 * cheaper than the full acquire path for the common "not due yet"
 * case. Returns 0 if the lock does not exist.
 */
export async function readLastConsolidatedMs(memoryDir: string): Promise<number> {
  const info = await readLockContent(lockPath(memoryDir));
  return info?.mtimeMs ?? 0;
}

/**
 * Attempt to acquire the lock. Returns `{ acquired: true, ... }` on
 * success, or `{ acquired: false, heldByPid, reason }` on failure.
 *
 * Acquire protocol:
 *   1. Read existing lock (if any)
 *   2. If lock exists and holder PID is alive and mtime is fresh (<
 *      staleMs), refuse — another process is working
 *   3. Otherwise write our PID to the lock file
 *   4. Re-read to confirm we won the race (another process may have
 *      written between our stat and our write)
 *
 * The caller is responsible for calling `releaseLock` with the
 * `recordConsolidation=true` flag on success, or `false` on early
 * abort, so the mtime reflects the correct state.
 */
export async function acquireLock(
  memoryDir: string,
  staleMs: number,
): Promise<LockAcquireResult> {
  await mkdir(memoryDir, { recursive: true });
  const path = lockPath(memoryDir);

  const existing = await readLockContent(path);
  const priorMtimeMs = existing?.mtimeMs ?? 0;

  if (existing) {
    const age = Date.now() - existing.mtimeMs;
    const stale = age > staleMs;
    const alive = isPidAlive(existing.pid);
    if (!stale && alive) {
      return {
        acquired: false,
        priorMtimeMs,
        heldByPid: existing.pid,
        reason: `lock held by live pid ${existing.pid}, ${Math.round(age / 1000)}s old`,
      };
    }
    if (stale || !alive) {
      logger.info(
        { memoryDir, heldByPid: existing.pid, ageMs: age, stale, alive },
        "cortexDream: reclaiming stale lock",
      );
    }
  }

  // Write our PID. Use writeFile with a flag=w (default) so we
  // clobber any existing body — this is how we win a race.
  await writeFile(path, String(process.pid), "utf-8");

  // Re-read to confirm. Another process may have written between
  // our stat and our write; whoever wrote last owns the lock.
  const confirmed = await readLockContent(path);
  if (!confirmed || confirmed.pid !== process.pid) {
    return {
      acquired: false,
      priorMtimeMs,
      heldByPid: confirmed?.pid,
      reason: `race lost to pid ${confirmed?.pid ?? "(unknown)"}`,
    };
  }

  return { acquired: true, priorMtimeMs };
}

/**
 * Release the lock. If `recordConsolidation=true`, bump the mtime
 * to "now" so the next gate check reads a fresh
 * `lastConsolidatedAt`. If `false`, restore the prior mtime so a
 * failed run does not count as a successful consolidation.
 *
 * Never throws — lock release is a best-effort cleanup path. If the
 * lock file has been tampered with or deleted, log and move on.
 */
export async function releaseLock(
  memoryDir: string,
  opts: { recordConsolidation: boolean; priorMtimeMs: number },
): Promise<void> {
  const path = lockPath(memoryDir);
  try {
    if (opts.recordConsolidation) {
      // Leaving the body as our PID; cortexDream's gate check reads
      // only the mtime, which is already "now" from the acquire
      // path. The next acquire will either reclaim (we're not
      // running anymore) or refuse (we ARE running).
      const now = new Date();
      await utimes(path, now, now);
    } else {
      // Failure path: pretend this run never happened by rewinding
      // the mtime. Body stays as our PID for one more beat, but the
      // next acquire will see the old mtime and gate on time again.
      if (opts.priorMtimeMs > 0) {
        const prior = new Date(opts.priorMtimeMs);
        await utimes(path, prior, prior);
      }
      // If priorMtimeMs=0, the lock is brand new and there is
      // nothing to restore. Leaving our PID + current mtime is
      // acceptable because gate still runs full 24h from now.
    }
  } catch (err) {
    logger.warn(
      { memoryDir, error: formatErrorMessage(err) },
      "cortexDream: lock release failed",
    );
  }
}
