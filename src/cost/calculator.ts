import { getPricing } from "./pricing.js";
import { logger } from "../infra/logger.js";
import type { SessionCostMetrics } from "../sessions/types.js";

export type { SessionCostMetrics };

/**
 * Token usage shape passed to the calculator. Fields mirror the
 * provider-agnostic StreamDone.usage contract — cache counts are
 * optional because only prompt-caching providers (Anthropic) emit
 * them. Missing cache counts default to 0.
 *
 * IMPORTANT: `promptTokens` should be the BILLABLE input count, i.e.
 * already excluding any cache-hit tokens that were billed under the
 * cache-read line. Providers that report cache tokens separately
 * also decrement them from prompt_tokens, so passing them through
 * unchanged produces the correct total.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface CostBreakdown {
  /** Total cost in USD for this usage record. */
  usd: number;
  /** Per-component breakdown so a caller can render "$0.03 input, $0.12 output". */
  components: {
    inputUsd: number;
    outputUsd: number;
    cacheWriteUsd: number;
    cacheReadUsd: number;
  };
  /** True if we had pricing for this model. When false, `usd` is 0. */
  priced: boolean;
}

const MTOK = 1_000_000;

/**
 * Compute USD cost for a single usage record. Always safe to call —
 * unknown models return `{ usd: 0, priced: false }` and log a one-time
 * warning at the inference layer (not here, to keep this pure).
 */
export function calculateCost(model: string, usage: TokenUsage): CostBreakdown {
  const pricing = getPricing(model);
  if (!pricing) {
    return {
      usd: 0,
      components: { inputUsd: 0, outputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0 },
      priced: false,
    };
  }

  const cacheWriteTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadInputTokens ?? 0;

  const inputUsd = (usage.promptTokens * pricing.inputPerMTok) / MTOK;
  const outputUsd = (usage.completionTokens * pricing.outputPerMTok) / MTOK;
  const cacheWriteUsd = (cacheWriteTokens * pricing.cacheWritePerMTok) / MTOK;
  const cacheReadUsd = (cacheReadTokens * pricing.cacheReadPerMTok) / MTOK;

  return {
    usd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd,
    components: { inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd },
    priced: true,
  };
}

export function createEmptyCostMetrics(): SessionCostMetrics {
  return {
    totalUsd: 0,
    turnsPriced: 0,
    turnsUnpriced: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheReadTokens: 0,
  };
}

/**
 * Fold a turn's usage into a running session cost bag. Mutates in
 * place for efficiency — cost accumulation is on the hot turn path
 * and creating a new object per turn is wasteful.
 *
 * Warning logging for unpriced models happens once per (session,
 * model) pair so a long chat with an unpriced model doesn't flood
 * the log. The dedup set is managed by the caller.
 */
export function accumulateCost(
  metrics: SessionCostMetrics,
  model: string,
  usage: TokenUsage,
  warnedUnpricedModels?: Set<string>,
): CostBreakdown {
  const breakdown = calculateCost(model, usage);

  metrics.totalPromptTokens += usage.promptTokens;
  metrics.totalCompletionTokens += usage.completionTokens;
  metrics.totalCacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
  metrics.totalCacheReadTokens += usage.cacheReadInputTokens ?? 0;

  if (breakdown.priced) {
    metrics.totalUsd += breakdown.usd;
    metrics.turnsPriced += 1;
  } else {
    metrics.turnsUnpriced += 1;
    if (warnedUnpricedModels && !warnedUnpricedModels.has(model)) {
      warnedUnpricedModels.add(model);
      logger.warn(
        { model },
        "Cost tracker: no pricing entry for model — USD cost will read 0 for all turns on this model",
      );
    }
  }

  return breakdown;
}
