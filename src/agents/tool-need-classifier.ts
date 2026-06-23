/**
 * Tool-need classifier. Detects "this query likely requires a current-
 * information tool call" and tells the inference layer to bias the
 * model toward calling that tool.
 *
 * Distinct from content-class.ts (which is about REFUSAL routing) on
 * purpose: different concern, different keyword surface, different
 * downstream effect. content-class.ts answers "should this refusal
 * reroute?"; this answers "should the agent be told to call a tool?".
 *
 * The detection logic itself lives in news-shape.ts so the web_search
 * tool's auto-promote path can share the same trigger list — keeping
 * the classifier's "tell the model to use the tool" decision and the
 * tool's "call the news vertical" decision consistent on every prompt.
 *
 * The output is advisory, not binding. The inference layer injects a
 * one-line system note when this classifier triggers, but does not
 * force tool execution. Models that confabulate from training memory
 * on news queries get told to use the tool; models that already would
 * have called the tool see the note as confirmation. The router catches
 * the cases arbiter's deterministic parser misses — anaphoric
 * follow-ups ("what's the latest on that?"), conversational pivots,
 * ambiguous phrasing. Arbiter's parseNewsSearch handles the explicit
 * cases by routing to web_search directly without any LLM round-trip.
 */

import { isNewsQuery, type NeededTool } from "./news-shape.js";

export type { NeededTool } from "./news-shape.js";

export interface ToolNeedResult {
  /** Which tool the user's prompt suggests they need. null = no signal. */
  readonly tool: NeededTool | null;
  /** Why this classification fired. Surfaced in the audit log so a
   *  user-visible "agent was told to use web_search" is traceable. */
  readonly reason: string;
  /** The lowercased substring that matched, for diagnostics. */
  readonly matchedTrigger?: string;
}

/**
 * Run the classifier. Returns `{ tool: null, ... }` when no trigger
 * matched — the caller treats that as "no guidance to inject."
 */
export function classifyToolNeed(userPrompt: string): ToolNeedResult {
  const news = isNewsQuery(userPrompt);
  if (news.matched && news.trigger) {
    return {
      tool: "web_search",
      reason: `prompt contains current-info trigger "${news.trigger}" — model should call web_search rather than answer from training memory`,
      matchedTrigger: news.trigger,
    };
  }
  return {
    tool: null,
    reason: "no current-info triggers detected",
  };
}

/**
 * Build the per-turn system note injected when classifyToolNeed fires.
 * Kept terse — long guidance bloats the prompt and the model glosses
 * over it. The single-paragraph form is the sweet spot for compliance
 * without crowding out other instructions.
 *
 * `capId` MUST be the per-session capability ID for the tool, not the
 * human-readable tool name. The model invokes tools by cap ID; using
 * the human name in guidance produces "Unknown capability ID" errors
 * and a topic-drift cascade as the model retries with confabulated args.
 */
export function toolNeedGuidance(tool: NeededTool, capId: string): string {
  switch (tool) {
    case "web_search":
      return [
        "[TOOL GUIDANCE — THIS TURN ONLY]",
        `The user is asking for current/recent information that is not in your training data (game patches, news, current events, version status, ongoing situations). You MUST call the \`${capId}\` function (the web search tool) before answering. Do not answer from memory. Do not invent URLs, version numbers, or dates that you cannot verify from a tool call. If the search returns nothing useful, say so explicitly rather than confabulating.`,
      ].join("\n");
  }
}
