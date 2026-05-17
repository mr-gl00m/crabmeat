import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateCost,
  accumulateCost,
  createEmptyCostMetrics,
} from "./calculator.js";
import { getPricing, __resetPricingWarnings, PRICING } from "./pricing.js";

describe("pricing table", () => {
  beforeEach(() => __resetPricingWarnings());

  it("returns exact entry for a known model", () => {
    const p = getPricing("claude-opus-4-6");
    expect(p).toBeDefined();
    expect(p!.inputPerMTok).toBe(15);
    expect(p!.outputPerMTok).toBe(75);
  });

  it("resolves dated revisions via longest-prefix match", () => {
    const dated = getPricing("claude-sonnet-4-6-20250901");
    const base = getPricing("claude-sonnet-4-6");
    expect(dated).toEqual(base);
  });

  it("returns undefined for unknown models", () => {
    expect(getPricing("made-up-model-xyz")).toBeUndefined();
  });

  it("cache write is 1.25x input for Anthropic models", () => {
    const p = getPricing("claude-opus-4-6")!;
    expect(p.cacheWritePerMTok).toBeCloseTo(p.inputPerMTok * 1.25);
  });

  it("cache read is 0.1x input for Anthropic models", () => {
    const p = getPricing("claude-opus-4-6")!;
    expect(p.cacheReadPerMTok).toBeCloseTo(p.inputPerMTok * 0.1);
  });

  it("case-insensitive lookup", () => {
    expect(getPricing("CLAUDE-OPUS-4-6")).toEqual(PRICING["claude-opus-4-6"]);
  });
});

describe("calculateCost", () => {
  beforeEach(() => __resetPricingWarnings());

  it("sums base input + output for a priced model", () => {
    // 1M input tokens × $15 + 1M output tokens × $75 = $90
    const out = calculateCost("claude-opus-4-6", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(out.priced).toBe(true);
    expect(out.usd).toBeCloseTo(90);
    expect(out.components.inputUsd).toBeCloseTo(15);
    expect(out.components.outputUsd).toBeCloseTo(75);
  });

  it("includes cache write + read when provided", () => {
    // 100k cache write × ($15 × 1.25 / 1M) = $1.875
    // 500k cache read × ($15 × 0.1 / 1M) = $0.75
    const out = calculateCost("claude-opus-4-6", {
      promptTokens: 0,
      completionTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 500_000,
    });
    expect(out.components.cacheWriteUsd).toBeCloseTo(1.875);
    expect(out.components.cacheReadUsd).toBeCloseTo(0.75);
    expect(out.usd).toBeCloseTo(2.625);
  });

  it("unknown model returns priced=false and usd=0", () => {
    const out = calculateCost("made-up-model-xyz", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(out.priced).toBe(false);
    expect(out.usd).toBe(0);
  });

  it("missing cache fields default to zero", () => {
    const out = calculateCost("claude-haiku-4-5", {
      promptTokens: 1_000,
      completionTokens: 1_000,
    });
    expect(out.components.cacheWriteUsd).toBe(0);
    expect(out.components.cacheReadUsd).toBe(0);
  });
});

describe("accumulateCost", () => {
  beforeEach(() => __resetPricingWarnings());

  it("mutates metrics in place and returns the breakdown", () => {
    const m = createEmptyCostMetrics();
    const out = accumulateCost(m, "claude-haiku-4-5", {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
    });
    // 1M × $1 + 0.5M × $5 = $1 + $2.5 = $3.5
    expect(out.usd).toBeCloseTo(3.5);
    expect(m.totalUsd).toBeCloseTo(3.5);
    expect(m.totalPromptTokens).toBe(1_000_000);
    expect(m.totalCompletionTokens).toBe(500_000);
    expect(m.turnsPriced).toBe(1);
    expect(m.turnsUnpriced).toBe(0);
  });

  it("accretes across multiple turns", () => {
    const m = createEmptyCostMetrics();
    accumulateCost(m, "claude-haiku-4-5", { promptTokens: 500_000, completionTokens: 250_000 });
    accumulateCost(m, "claude-haiku-4-5", { promptTokens: 500_000, completionTokens: 250_000 });
    // Each turn: 500k × $1 + 250k × $5 = $0.5 + $1.25 = $1.75 → two turns = $3.5
    expect(m.totalUsd).toBeCloseTo(3.5);
    expect(m.turnsPriced).toBe(2);
  });

  it("unknown model bumps turnsUnpriced but not totalUsd", () => {
    const m = createEmptyCostMetrics();
    const warned = new Set<string>();
    accumulateCost(m, "made-up-model-xyz", {
      promptTokens: 1_000,
      completionTokens: 1_000,
    }, warned);
    expect(m.totalUsd).toBe(0);
    expect(m.turnsUnpriced).toBe(1);
    expect(m.turnsPriced).toBe(0);
    expect(warned.has("made-up-model-xyz")).toBe(true);
  });

  it("warns once per unpriced model via the dedup set", () => {
    const m = createEmptyCostMetrics();
    const warned = new Set<string>();
    accumulateCost(m, "made-up-model-xyz", { promptTokens: 1, completionTokens: 1 }, warned);
    accumulateCost(m, "made-up-model-xyz", { promptTokens: 1, completionTokens: 1 }, warned);
    accumulateCost(m, "made-up-model-xyz", { promptTokens: 1, completionTokens: 1 }, warned);
    expect(warned.size).toBe(1);
    expect(m.turnsUnpriced).toBe(3);
  });

  it("mixed priced + unpriced accumulates cost only for priced turns", () => {
    const m = createEmptyCostMetrics();
    accumulateCost(m, "claude-haiku-4-5", { promptTokens: 1_000_000, completionTokens: 0 });
    accumulateCost(m, "unpriced-model", { promptTokens: 999_999, completionTokens: 999_999 });
    expect(m.totalUsd).toBeCloseTo(1);
    expect(m.turnsPriced).toBe(1);
    expect(m.turnsUnpriced).toBe(1);
    // Token totals accrue for both turns — they're independent of pricing.
    expect(m.totalPromptTokens).toBe(1_999_999);
  });
});
