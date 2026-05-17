/**
 * News / current-events intent parser. Catches phrasings that mean
 * "the user is asking about current information" and routes them to a
 * web_search intent, same shape as parseWebSearch produces. Distinct
 * from the bare "search for X" pattern because users don't usually
 * say "search for the latest news on Overwatch" — they say "what's
 * the latest on Overwatch."
 *
 * Anaphoric topics (just a pronoun like "that" / "it" / "this") are
 * deliberately rejected. We can't resolve "what's the latest on that"
 * from surface text alone — the prior turn's context is needed, and
 * that's the LLM's job. Returning null sends those queries down the
 * inference path where the content-class router on the consumer side
 * picks them up and biases the model toward calling web_search.
 *
 * CROSS-PROJECT PARALLEL: CrabMeat maintains a parallel keyword list at
 * crabmeat/src/agents/news-shape.ts (used by the tool-
 * need classifier and the web_search tool's news-vertical auto-promote).
 * The two lists serve different parsers — this one is regex-based with
 * topic capture, the CrabMeat one is substring-based for detection only
 * — but the underlying concept is the same. When you add a trigger
 * phrase here, add the equivalent substring to news-shape.ts (and vice
 * versa) so the agent's behavior stays consistent across the
 * deterministic-arbiter path and the LLM-direct path.
 */
import type { EffectClass, IntentAction } from "../types.js";
export interface NewsSearchParse {
    readonly action: Extract<IntentAction, "web_search">;
    readonly effectClass: Extract<EffectClass, "search" | "network">;
    readonly params: {
        readonly query: string;
    };
}
export declare function parseNewsSearch(text: string): NewsSearchParse | null;
//# sourceMappingURL=news-search.d.ts.map