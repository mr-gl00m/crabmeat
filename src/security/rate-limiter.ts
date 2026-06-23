/**
 * Sliding-window rate limiter. Tracks attempts per key (typically IP)
 * with configurable window size, max attempts, and lockout duration.
 *
 * Optional exponential lockout backoff: when a key gets locked out,
 * tripping the limiter again on the next allowed attempt extends the
 * lockout by `lockoutBackoffMultiplier^N`, capped at `maxLockoutMs`.
 * Backoff state resets after `lockoutResetMs` of clean activity. Designed
 * for auth surfaces where a brute-forcer who keeps coming back should
 * meet a wall that grows from minutes to hours, not a flat 60s door.
 */
export interface RateLimiterConfig {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
  /** Multiplier applied to lockoutMs for each consecutive lockout. Default 1 (no backoff). */
  lockoutBackoffMultiplier?: number;
  /** Hard cap on a single lockout duration when backoff is enabled. */
  maxLockoutMs?: number;
  /** Backoff resets after this many ms of clean activity. Default windowMs * 4. */
  lockoutResetMs?: number;
}

interface Entry {
  timestamps: number[];
  lockedUntil: number;
  consecutiveLockouts: number;
  lastLockoutAt: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly config: RateLimiterConfig;
  private readonly backoffMultiplier: number;
  private readonly maxLockoutMs: number;
  private readonly lockoutResetMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.backoffMultiplier = config.lockoutBackoffMultiplier ?? 1;
    this.maxLockoutMs = config.maxLockoutMs ?? config.lockoutMs * 256;
    this.lockoutResetMs = config.lockoutResetMs ?? config.windowMs * 4;
    this.cleanupTimer = setInterval(() => this.cleanup(), config.windowMs * 2);
    // Allow the timer to not prevent process exit
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private computeLockoutMs(consecutive: number): number {
    if (this.backoffMultiplier <= 1) return this.config.lockoutMs;
    const scaled = this.config.lockoutMs * Math.pow(this.backoffMultiplier, Math.max(0, consecutive - 1));
    return Math.min(scaled, this.maxLockoutMs);
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   * Automatically records the attempt.
   */
  check(key: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry) {
      entry = { timestamps: [], lockedUntil: 0, consecutiveLockouts: 0, lastLockoutAt: 0 };
      this.entries.set(key, entry);
    }

    // Reset consecutive-lockout counter after a clean stretch — without
    // this, an IP that misbehaved hours ago and has been quiet since
    // would still face the maximum backoff on its next mistake.
    if (
      entry.consecutiveLockouts > 0 &&
      entry.lastLockoutAt > 0 &&
      now - entry.lastLockoutAt > this.lockoutResetMs &&
      now >= entry.lockedUntil
    ) {
      entry.consecutiveLockouts = 0;
    }

    // Check lockout
    if (now < entry.lockedUntil) return false;

    // Slide the window
    const windowStart = now - this.config.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    // Check limit
    if (entry.timestamps.length >= this.config.maxAttempts) {
      entry.consecutiveLockouts += 1;
      const lockoutDuration = this.computeLockoutMs(entry.consecutiveLockouts);
      entry.lockedUntil = now + lockoutDuration;
      entry.lastLockoutAt = now;
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Remaining attempts before rate limiting kicks in. */
  remaining(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return this.config.maxAttempts;
    if (Date.now() < entry.lockedUntil) return 0;

    const windowStart = Date.now() - this.config.windowMs;
    const recent = entry.timestamps.filter((t) => t > windowStart).length;
    return Math.max(0, this.config.maxAttempts - recent);
  }

  /** Remove expired entries to prevent memory growth. */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.entries) {
      if (now >= entry.lockedUntil) {
        entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
        // Preserve entries that still hold backoff state — deleting them
        // would let an attacker reset the exponential lockout multiplier
        // simply by waiting out the cleanup interval.
        const backoffStillActive =
          entry.consecutiveLockouts > 0 &&
          now - entry.lastLockoutAt < this.lockoutResetMs;
        if (entry.timestamps.length === 0 && !backoffStillActive) {
          keysToDelete.push(key);
        }
      }
    }

    for (const key of keysToDelete) {
      this.entries.delete(key);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
  }
}
