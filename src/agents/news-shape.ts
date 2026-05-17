/**
 * Shared "is this a news / current-info query?" detector.
 *
 * Two CrabMeat surfaces ask the same question for different reasons:
 *
 *   1. tool-need-classifier.ts injects a "you MUST call web_search"
 *      system note when the user prompt is news-shaped, biasing the
 *      model toward calling the tool.
 *   2. tools/web-search.ts auto-promotes the search topic to the
 *      "news" vertical (Tavily/Brave) when the query is news-shaped,
 *      so the agent gets dated articles instead of general results.
 *
 * Both used to maintain their own keyword list. The lists drifted —
 * "have you heard about the latest patch" matched the classifier but
 * not the auto-promote, so the model got told to call web_search and
 * then web_search returned weaker general-vertical results. Unifying
 * the trigger set here means the answer is consistent across both
 * consumers.
 *
 * Note on cross-module parallel: arbiter has its own news-detection
 * regex at crabmeat/vendor/arbiter/src/parse/news-search.ts. The vendored
 * arbiter is the single source of truth for arbiter code now (proj_ai_arbiter
 * was folded in 2026-05-14), but keeping the two trigger lists separate
 * still matters because they serve different parsers (substring vs regex
 * with topic capture). When you add a trigger here, add the equivalent
 * regex pattern to arbiter's news-search.ts (and vice versa). The
 * underlying concept is the same.
 */

export type NeededTool = "web_search";

export interface NewsQueryResult {
  /** Did the prompt contain a news/current-info trigger? */
  readonly matched: boolean;
  /** The lowercased substring that matched, if any. Useful for logs. */
  readonly trigger?: string;
}

/**
 * Phrases that signal "the user wants current information that the
 * model's training data won't cover." Lowercase; the haystack is
 * lowercased once. Order matters — first match wins. Multi-word phrases
 * sit ahead of single-word triggers because "latest patch" should match
 * before bare "latest" would.
 *
 * Triggers are intentionally conservative. False positives ("what's
 * the latest version of Python") cost a tool round-trip the user
 * probably wanted anyway. False negatives ("any updates?") cost a
 * confabulated answer with fake URLs — the failure mode we're trying
 * to fix.
 *
 * Ordered most-specific first so the matched trigger reported back is
 * useful in logs. "any news on X" should report as "any news", not as
 * "news on" (which would also match the same string).
 */
export const NEWS_TRIGGERS: readonly string[] = [
  // Multi-word recency phrasings (most specific)
  "what's the latest",
  "whats the latest",
  "what is the latest",
  "what's happening",
  "whats happening",
  "what is happening",
  "what's going on",
  "whats going on",
  "what is going on",
  "what's new with",
  "whats new with",
  "what is new with",
  "what's new on",
  "whats new on",
  "what is new on",
  "what's the current",
  "whats the current",
  "what is the current",
  "current state of",
  "current status of",
  "current events",
  "any updates",
  "any news",
  "anything new",
  "recent updates",
  "recent news",
  "recent changes",
  "latest news",
  "current news",
  "latest patch",
  "newest patch",
  "patch notes",
  "current meta",
  "latest meta",
  "latest version",
  "newest version",
  // Past-tense phrasings — news-shaped questions about state changes
  "what happened to",
  "what happened with",
  // Release-status phrasings — game / movie / product launches
  "out yet",
  "released yet",
  "come out yet",
  "launch date",
  "release date",
  // Conversational pickups — common news handoffs
  "have you heard",
  "did you hear",
  // Headline / press / breaking news shape
  "breaking news",
  "press release",
  "headlines",
  "headline",
  // Single-prep phrasings (broader; come last so they don't shadow above)
  "news on",
  "news about",
  "announcement",
  // Bare recency markers
  "right now",
  "today's",
  "this week's",
  "as of today",
  "as of this week",
];

/**
 * Run the detector. Returns `{ matched: false }` when no trigger
 * matched — the caller treats that as "no signal."
 */
export function isNewsQuery(prompt: string): NewsQueryResult {
  const lowered = prompt.toLowerCase();
  for (const trigger of NEWS_TRIGGERS) {
    if (lowered.includes(trigger)) {
      return { matched: true, trigger };
    }
  }
  return { matched: false };
}
