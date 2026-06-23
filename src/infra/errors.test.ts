import { describe, it, expect } from "vitest";
import {
  CrabMeatError,
  AuthError,
  RateLimitError,
  ValidationError,
  ProviderError,
  formatError,
  isRetryable,
} from "./errors.js";

describe("error classes", () => {
  it("CrabMeatError has correct fields", () => {
    const err = new CrabMeatError("TEST", "test msg", 400, { detail: true });
    expect(err.code).toBe("TEST");
    expect(err.message).toBe("test msg");
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({ detail: true });
    expect(err.name).toBe("CrabMeatError");
  });

  it("AuthError defaults to 401", () => {
    const err = new AuthError("bad creds");
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.statusCode).toBe(401);
  });

  it("RateLimitError defaults to 429", () => {
    const err = new RateLimitError();
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.statusCode).toBe(429);
  });

  it("ValidationError defaults to 400", () => {
    const err = new ValidationError("bad input");
    expect(err.statusCode).toBe(400);
  });

  it("ProviderError tracks providerId and retryable", () => {
    const err = new ProviderError("openai", "rate limited", true, 429);
    expect(err.providerId).toBe("openai");
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
  });
});

describe("formatError", () => {
  it("formats CrabMeatError", () => {
    const { code, message } = formatError(new AuthError("nope"));
    expect(code).toBe("AUTH_FAILED");
    expect(message).toBe("nope");
  });

  it("formats generic Error", () => {
    const { code, message } = formatError(new Error("oops"));
    expect(code).toBe("INTERNAL_ERROR");
    expect(message).toBe("oops");
  });

  it("formats non-Error values", () => {
    const { code, message } = formatError("string error");
    expect(code).toBe("INTERNAL_ERROR");
    expect(message).toBe("string error");
  });

  it("formats null", () => {
    const { code, message } = formatError(null);
    expect(code).toBe("INTERNAL_ERROR");
    expect(message).toBe("null");
  });
});

describe("isRetryable", () => {
  it("returns true for retryable ProviderError", () => {
    expect(isRetryable(new ProviderError("p", "err", true))).toBe(true);
  });

  it("returns false for non-retryable ProviderError", () => {
    expect(isRetryable(new ProviderError("p", "err", false))).toBe(false);
  });

  it("returns false for non-ProviderError", () => {
    expect(isRetryable(new Error("generic"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryable("string")).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});
