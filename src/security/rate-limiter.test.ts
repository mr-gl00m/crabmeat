import { describe, it, expect, afterEach } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it("allows requests within the limit", () => {
    limiter = new RateLimiter({
      windowMs: 60_000,
      maxAttempts: 3,
      lockoutMs: 10_000,
    });

    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
  });

  it("blocks after exceeding the limit", () => {
    limiter = new RateLimiter({
      windowMs: 60_000,
      maxAttempts: 2,
      lockoutMs: 10_000,
    });

    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    // Third attempt triggers lockout
    expect(limiter.check("1.2.3.4")).toBe(false);
  });

  it("tracks keys independently", () => {
    limiter = new RateLimiter({
      windowMs: 60_000,
      maxAttempts: 1,
      lockoutMs: 10_000,
    });

    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("5.6.7.8")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
    expect(limiter.check("5.6.7.8")).toBe(false);
  });

  it("reports remaining attempts", () => {
    limiter = new RateLimiter({
      windowMs: 60_000,
      maxAttempts: 3,
      lockoutMs: 10_000,
    });

    expect(limiter.remaining("1.2.3.4")).toBe(3);
    limiter.check("1.2.3.4");
    expect(limiter.remaining("1.2.3.4")).toBe(2);
    limiter.check("1.2.3.4");
    expect(limiter.remaining("1.2.3.4")).toBe(1);
  });
});
