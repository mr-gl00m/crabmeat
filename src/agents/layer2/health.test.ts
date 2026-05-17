import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkLayer2Health, resetHealthCache, isHealthCacheValid } from "./health.js";
import type { Provider, StreamEvent } from "../providers/types.js";

function makeProvider(
  id: string,
  behavior: "healthy" | "error" | "timeout",
): Provider {
  return {
    id,
    type: "openai",
    stream: vi.fn(async (_req, onEvent) => {
      if (behavior === "healthy") {
        onEvent({ type: "token", text: "ok" } as StreamEvent);
        onEvent({ type: "done", usage: { promptTokens: 1, completionTokens: 1 } } as StreamEvent);
      } else if (behavior === "error") {
        onEvent({ type: "error", error: new Error("Model not found"), retryable: false } as StreamEvent);
      } else if (behavior === "timeout") {
        // Never resolve — simulates a hanging model
        await new Promise(() => {});
      }
    }),
  };
}

describe("checkLayer2Health", () => {
  beforeEach(() => {
    resetHealthCache();
  });

  it("returns true when provider responds with a token", async () => {
    const provider = makeProvider("test-healthy", "healthy");
    const result = await checkLayer2Health(provider, 2000);
    expect(result).toBe(true);
  });

  it("returns false when provider returns an error", async () => {
    const provider = makeProvider("test-error", "error");
    const result = await checkLayer2Health(provider, 2000);
    expect(result).toBe(false);
  });

  it("returns false when provider times out", async () => {
    const provider = makeProvider("test-timeout", "timeout");
    const result = await checkLayer2Health(provider, 50); // Very short timeout
    expect(result).toBe(false);
  });

  it("caches healthy result within TTL", async () => {
    const provider = makeProvider("test-cache", "healthy");
    await checkLayer2Health(provider, 2000);
    expect(isHealthCacheValid("test-cache")).toBe(true);

    // Second call should use cache, not call stream again
    await checkLayer2Health(provider, 2000);
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("caches unhealthy result within TTL", async () => {
    const provider = makeProvider("test-unhealthy-cache", "error");
    const result1 = await checkLayer2Health(provider, 2000);
    expect(result1).toBe(false);

    // Second call should use cache
    const result2 = await checkLayer2Health(provider, 2000);
    expect(result2).toBe(false);
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("resetHealthCache forces fresh check", async () => {
    const provider = makeProvider("test-reset", "healthy");
    await checkLayer2Health(provider, 2000);
    expect(provider.stream).toHaveBeenCalledTimes(1);

    resetHealthCache("test-reset");
    expect(isHealthCacheValid("test-reset")).toBe(false);

    await checkLayer2Health(provider, 2000);
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it("resetHealthCache without arg clears all entries", async () => {
    const p1 = makeProvider("p1", "healthy");
    const p2 = makeProvider("p2", "healthy");
    await checkLayer2Health(p1, 2000);
    await checkLayer2Health(p2, 2000);

    resetHealthCache();
    expect(isHealthCacheValid("p1")).toBe(false);
    expect(isHealthCacheValid("p2")).toBe(false);
  });
});
