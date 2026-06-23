/**
 * pending-input — per-session interrupt buffer.
 *
 * The CLI (or any client) can push content here mid-turn via the
 * chat.queue WS frame. The agent loop drains the buffer at each
 * iteration boundary so user interrupts ("wait, also…", "--killbot")
 * are honored without having to wait for the current turn to finish.
 *
 * Design:
 *   - Module-level Map<sessionKey, PendingEntry[]> — a single shared
 *     buffer the WS handler writes to and the agent loop reads from.
 *   - FIFO order; drain returns entries in arrival order.
 *   - Per-session cap (MAX_PENDING_PER_SESSION) so an abusive client
 *     can't grow the buffer unbounded. Overflow is dropped silently —
 *     the WS handler surfaces this as a "queue full" error.
 *   - Control tokens (--killbot, /killbot) are *not* buffered here.
 *     They're detected and handled synchronously by the WS handler
 *     (trip the breaker + clear the queue), because buffering a kill
 *     command would defeat the whole point.
 *
 * This module is intentionally simple — no TTL, no persistence. If
 * the process dies, pending entries die with it, which is correct:
 * they're user input for an in-flight turn that also dies.
 */

export const MAX_PENDING_PER_SESSION = 16;
export const MAX_PENDING_CONTENT_LEN = 4_000;

export interface PendingEntry {
  /** When the entry was enqueued. */
  enqueuedAt: number;
  /** The raw user text. */
  content: string;
}

const buffers = new Map<string, PendingEntry[]>();

/**
 * Enqueue a pending input for a session.
 *
 * Returns the new queue length on success, or -1 if the queue is
 * full (caller should surface QUEUE_FULL to the client).
 */
export function enqueuePendingInput(
  sessionKey: string,
  content: string,
): number {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return -1;
  if (typeof content !== "string" || content.length === 0) return -1;

  const trimmed = content.slice(0, MAX_PENDING_CONTENT_LEN);

  let list = buffers.get(sessionKey);
  if (!list) {
    list = [];
    buffers.set(sessionKey, list);
  }
  if (list.length >= MAX_PENDING_PER_SESSION) return -1;

  list.push({ enqueuedAt: Date.now(), content: trimmed });
  return list.length;
}

/**
 * Drain and return all pending entries for a session (FIFO).
 * Called by the agent loop at iteration boundaries. After drain,
 * the per-session buffer is empty.
 */
export function drainPendingInput(sessionKey: string): PendingEntry[] {
  const list = buffers.get(sessionKey);
  if (!list || list.length === 0) return [];
  buffers.delete(sessionKey);
  return list;
}

/** Non-destructive peek used by tests and introspection. */
export function peekPendingInput(sessionKey: string): readonly PendingEntry[] {
  return buffers.get(sessionKey) ?? [];
}

/** Current queue length for a session. */
export function pendingInputCount(sessionKey: string): number {
  return buffers.get(sessionKey)?.length ?? 0;
}

/**
 * Clear a session's pending buffer unconditionally. Used by the
 * kill-token redemption path and the --killbot fast path: once the
 * breaker is tripped, there's no point delivering queued content.
 */
export function clearPendingInput(sessionKey: string): number {
  const list = buffers.get(sessionKey);
  if (!list) return 0;
  const n = list.length;
  buffers.delete(sessionKey);
  return n;
}

/** Test-only: wipe all pending buffers. */
export function _resetPendingInput(): void {
  buffers.clear();
}

/** Test-only: total entries across all sessions. */
export function _pendingInputTotal(): number {
  let n = 0;
  for (const list of buffers.values()) n += list.length;
  return n;
}

/** Test-only: list all session keys with pending entries. */
export function _listPendingSessions(): string[] {
  return Array.from(buffers.keys());
}

// ── Control token detection ──────────────────────────────

/**
 * Recognized control tokens that must NOT be buffered — they're
 * handled synchronously by the WS handler (trip breaker, clear queue).
 * We match on trimmed, case-insensitive input to forgive typos like
 * "  --Killbot ".
 */
const KILL_TOKENS = new Set(["--killbot", "/killbot", "--kill", "/kill"]);

export function isControlKillToken(content: string): boolean {
  if (typeof content !== "string") return false;
  return KILL_TOKENS.has(content.trim().toLowerCase());
}
