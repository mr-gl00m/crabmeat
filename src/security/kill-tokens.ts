/**
 * kill-tokens — single-use short-lived tokens for the "emergency stop"
 * kill link that message_send embeds in every outbound external message.
 *
 * Design goals:
 *   - Every outbound message the agent sends to an external channel
 *     (Discord, Telegram, email, etc.) carries a clickable URL that,
 *     when fetched, trips the circuit breaker for that session. That
 *     way the user always has an out-of-band kill switch, no matter
 *     which channel they're reading the agent on.
 *   - Tokens are opaque, high-entropy, single-use, and TTL-bounded.
 *     One redemption is enough — even if an attacker later scrapes the
 *     channel log, the token is already dead.
 *   - State is in-memory only. A crash wipes outstanding tokens, which
 *     is the right behavior: on restart there's no rogue agent to kill.
 *
 * The token is the credential. Whoever holds it can trip the breaker
 * for the session it was bound to — no extra auth required. That's
 * intentional: the user must be able to kill the agent from whichever
 * device happens to be in front of them.
 */

import { randomBytes } from "node:crypto";
import { logger } from "../infra/logger.js";

/** Default TTL for a freshly issued kill token: one hour. */
export const KILL_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Hard cap on the TTL the caller may request. */
export const KILL_TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Token length in bytes (→ 2× hex chars). 192 bits of entropy. */
export const KILL_TOKEN_BYTE_LEN = 24;

/** Hard cap on the number of unredeemed tokens in flight. */
export const KILL_TOKEN_MAX_ACTIVE = 2048;

/** Sweep interval for purging expired tokens. */
export const KILL_TOKEN_SWEEP_INTERVAL_MS = 60_000;

interface KillTokenEntry {
  sessionKey: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
}

const entries: Map<string, KillTokenEntry> = new Map();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(token);
  }
}

/**
 * Ensure we don't grow past the cap. When at capacity, sweep first;
 * if still at cap, evict in insertion (issuance) order.
 */
function ensureCapacity(): void {
  if (entries.size < KILL_TOKEN_MAX_ACTIVE) return;
  sweep();
  while (entries.size >= KILL_TOKEN_MAX_ACTIVE) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * Issue a fresh single-use kill token bound to a session.
 *
 * @param sessionKey  The session the redeemed token will target.
 * @param reason      Human-readable reason surfaced to the user at
 *                    redemption time (e.g. "Deleting emails in Gmail").
 * @param ttlMs       Override TTL (defaults to KILL_TOKEN_TTL_MS).
 *                    Clamped to [1s, KILL_TOKEN_MAX_TTL_MS].
 */
export function issueKillToken(
  sessionKey: string,
  reason = "",
  ttlMs: number = KILL_TOKEN_TTL_MS,
): string {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new Error("issueKillToken: sessionKey is required");
  }
  ensureCapacity();
  const clampedTtl = Math.max(
    1_000,
    Math.min(KILL_TOKEN_MAX_TTL_MS, Math.floor(ttlMs)),
  );
  const token = randomBytes(KILL_TOKEN_BYTE_LEN).toString("hex");
  const now = Date.now();
  entries.set(token, {
    sessionKey,
    reason: reason.slice(0, 500),
    issuedAt: now,
    expiresAt: now + clampedTtl,
  });
  return token;
}

export interface RedeemedKillToken {
  sessionKey: string;
  reason: string;
  issuedAt: number;
}

/**
 * Atomically verify and redeem a kill token.
 *
 * Returns the redeemed entry on success (and removes the token from
 * the store), or null if the token is unknown, malformed, or expired.
 *
 * Redemption is single-use: a second call with the same token always
 * returns null.
 */
export function verifyAndRedeem(token: unknown): RedeemedKillToken | null {
  if (typeof token !== "string") return null;
  if (token.length !== KILL_TOKEN_BYTE_LEN * 2) return null;
  const entry = entries.get(token);
  if (!entry) return null;
  // Single-use: delete before the TTL check so a replay after expiry
  // still can't succeed on the next tick.
  entries.delete(token);
  if (entry.expiresAt <= Date.now()) return null;
  return {
    sessionKey: entry.sessionKey,
    reason: entry.reason,
    issuedAt: entry.issuedAt,
  };
}

/**
 * Revoke every outstanding token issued for a session. Called when
 * the session disconnects or gets a fresh circuit-breaker reset — any
 * old kill links from the previous run should no longer fire.
 */
export function revokeKillTokensForSession(sessionKey: string): number {
  let removed = 0;
  for (const [token, entry] of entries) {
    if (entry.sessionKey === sessionKey) {
      entries.delete(token);
      removed++;
    }
  }
  return removed;
}

/**
 * Start the background sweep that purges expired tokens. Safe to call
 * multiple times — only the first call starts the timer.
 */
export function startKillTokenSweeper(
  intervalMs: number = KILL_TOKEN_SWEEP_INTERVAL_MS,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.debug({ intervalMs }, "Kill-token sweeper started");
}

/** Stop the background sweep. Safe to call when not running. */
export function stopKillTokenSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

/** For tests — wipe all state and stop the sweeper. */
export function _resetKillTokens(): void {
  entries.clear();
  stopKillTokenSweeper();
}

/** For tests — peek at the unredeemed token count. */
export function _killTokenCount(): number {
  return entries.size;
}

/** For tests — peek at an entry without redeeming. */
export function _peekKillToken(token: string): KillTokenEntry | undefined {
  const entry = entries.get(token);
  return entry ? { ...entry } : undefined;
}
