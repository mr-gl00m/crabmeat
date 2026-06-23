import { RateLimiter } from "../../security/rate-limiter.js";

/**
 * Pre-configured rate limiters for gateway surfaces.
 * Applied at the server level, not per-handler.
 */

export function createAuthLimiter(): RateLimiter {
  // Auth is the highest-stakes surface — a brute-forcer who keeps coming
  // back deserves an exponentially worse experience. 10 failed attempts
  // per minute → first lockout 60s, then 5min, then 25min, then 2h, capped
  // at ~4h. Backoff state resets after 30 minutes of clean activity so a
  // user who fat-fingered their token an hour ago isn't punished forever.
  return new RateLimiter({
    windowMs: 60_000,
    maxAttempts: 10,
    lockoutMs: 60_000,
    lockoutBackoffMultiplier: 5,
    maxLockoutMs: 4 * 60 * 60 * 1000,
    lockoutResetMs: 30 * 60 * 1000,
  });
}

export function createConnectionLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60_000,
    maxAttempts: 20,
    lockoutMs: 30_000,
  });
}

export function createHookLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60_000,
    maxAttempts: 100,
    lockoutMs: 30_000,
  });
}
