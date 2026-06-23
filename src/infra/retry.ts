import { isRetryable } from "./errors.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Random jitter applied to each backoff delay as a fraction of the
   * computed delay. 0.2 means each delay is multiplied by a random value
   * in [0.8, 1.2]. Set to 0 for deterministic backoff.
   *
   * Default 0.2 prevents synchronized retry storms when many clients
   * hit the same provider rate limit at the same instant.
   */
  jitter: number;
}

const defaults: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: 0.2,
};

function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0) return delayMs;
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * factor));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = { ...defaults, ...opts };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const baseDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = applyJitter(baseDelay, jitter);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
