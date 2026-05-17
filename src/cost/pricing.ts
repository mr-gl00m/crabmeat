// Per-model USD pricing, expressed as dollars per million tokens.
//
// Cache rates follow Anthropic's published schedule: cache writes cost
// 1.25x base input, cache reads cost 0.10x base input. For providers
// without prompt caching (OpenAI non-o1), the cache-write / cache-read
// fields mirror the base input so accidental double-accounting still
// produces a correct number.
//
// Keep this list conservative. Unknown models return undefined and
// `calculateCost` degrades to `0` with a one-time warning, so the
// worst case is "we don't bill for that turn" — never a crash.

export interface ModelPricing {
  /** Base input, USD per million tokens. */
  inputPerMTok: number;
  /** Base output, USD per million tokens. */
  outputPerMTok: number;
  /** Cache-write rate (prompt caching). Defaults to 1.25 × input. */
  cacheWritePerMTok: number;
  /** Cache-read rate (prompt caching). Defaults to 0.10 × input. */
  cacheReadPerMTok: number;
}

const antrhopic = (input: number, output: number): ModelPricing => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheWritePerMTok: input * 1.25,
  cacheReadPerMTok: input * 0.1,
});

const openai = (input: number, output: number): ModelPricing => ({
  inputPerMTok: input,
  outputPerMTok: output,
  cacheWritePerMTok: input,
  cacheReadPerMTok: input * 0.5,
});

/**
 * USD/MTok pricing table. Keys are matched case-insensitively, and a
 * request for "claude-opus-4-6-20250101" resolves to "claude-opus-4-6"
 * via longest-prefix match so minor version bumps don't silently stop
 * tracking cost.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Anthropic — Claude 4.x family
  "claude-opus-4-6": antrhopic(15, 75),
  "claude-opus-4-5": antrhopic(15, 75),
  "claude-sonnet-4-6": antrhopic(3, 15),
  "claude-sonnet-4-5": antrhopic(3, 15),
  "claude-haiku-4-5": antrhopic(1, 5),
  // Anthropic — Claude 3.x legacy
  "claude-3-5-sonnet": antrhopic(3, 15),
  "claude-3-5-haiku": antrhopic(0.8, 4),
  "claude-3-opus": antrhopic(15, 75),
  // OpenAI
  "gpt-4o": openai(2.5, 10),
  "gpt-4o-mini": openai(0.15, 0.6),
  "o1-preview": openai(15, 60),
  "o1-mini": openai(3, 12),
};

const unknownModelWarnings = new Set<string>();

/**
 * Resolve pricing for a model id. Uses longest-prefix match so
 * dated revisions ("claude-opus-4-6-20250101") inherit from their
 * family. Unknown models log a single warning and return undefined.
 *
 * The caller decides what undefined means; `calculateCost` treats
 * it as $0 so cost is "unavailable" not "wrong".
 */
export function getPricing(model: string): ModelPricing | undefined {
  const lower = model.toLowerCase();
  if (PRICING[lower]) return PRICING[lower];

  let bestKey: string | undefined;
  for (const key of Object.keys(PRICING)) {
    if (lower.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey) return PRICING[bestKey];

  if (!unknownModelWarnings.has(lower)) {
    unknownModelWarnings.add(lower);
  }
  return undefined;
}

/** Test-only: reset the warning cache so each test starts clean. */
export function __resetPricingWarnings(): void {
  unknownModelWarnings.clear();
}
