import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../security/rate-limiter.js";

describe("Per-session tool rate limiting", () => {
  const limiters: RateLimiter[] = [];

  function makeLimiter(maxAttempts: number, windowMs = 60_000, lockoutMs = 30_000) {
    const rl = new RateLimiter({ maxAttempts, windowMs, lockoutMs });
    limiters.push(rl);
    return rl;
  }

  afterEach(() => {
    for (const rl of limiters) rl.destroy();
    limiters.length = 0;
    vi.restoreAllMocks();
  });

  it("allows tool calls within the rate limit", () => {
    const limiter = makeLimiter(3);
    expect(limiter.check("session-a")).toBe(true);
    expect(limiter.check("session-a")).toBe(true);
    expect(limiter.check("session-a")).toBe(true);
  });

  it("denies tool calls that exceed the rate limit", () => {
    const limiter = makeLimiter(2);
    expect(limiter.check("session-a")).toBe(true);
    expect(limiter.check("session-a")).toBe(true);
    // Third call should be denied
    expect(limiter.check("session-a")).toBe(false);
  });

  it("tracks sessions independently", () => {
    const limiter = makeLimiter(2);
    // Session A uses up its quota
    expect(limiter.check("session-a")).toBe(true);
    expect(limiter.check("session-a")).toBe(true);
    expect(limiter.check("session-a")).toBe(false);
    // Session B should still be unaffected
    expect(limiter.check("session-b")).toBe(true);
    expect(limiter.check("session-b")).toBe(true);
  });

  it("resets after the sliding window expires", () => {
    vi.useFakeTimers();
    try {
      const windowMs = 1_000;
      const lockoutMs = 500;
      const limiter = makeLimiter(2, windowMs, lockoutMs);

      expect(limiter.check("session-a")).toBe(true);
      expect(limiter.check("session-a")).toBe(true);
      expect(limiter.check("session-a")).toBe(false); // locked out

      // Advance past the lockout period + window
      vi.advanceTimersByTime(lockoutMs + windowMs + 1);

      // Should be allowed again
      expect(limiter.check("session-a")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
