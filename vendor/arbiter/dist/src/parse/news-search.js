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
import { trimTerminalPunct } from "./trim.js";
import { looksLikePathInjection } from "./path-jail.js";
import { searchAllowlist } from "./web-search.js";
const NEWS_PATTERNS = [
    // "what's the latest [news] on/about/with X" (contracted + uncontracted)
    /\b(?:what'?s|whats|what\s+is|tell\s+me)\s+(?:the\s+)?(?:latest|newest|most\s+recent|current)\s+(?:news\s+)?(?:about|on|with|for|regarding|in)\s+(.+?)\s*[?.!]*\s*$/i,
    // "any news / updates on X"
    /\b(?:any|got|is\s+there)\s+(?:news|updates?|info(?:rmation)?)\s+(?:about|on|regarding|with|for)\s+(.+?)\s*[?.!]*\s*$/i,
    // "anything new on/about X"
    /\banything\s+new\s+(?:about|on|with|regarding|for|in)\s+(.+?)\s*[?.!]*\s*$/i,
    // "news on/about X"
    /^\s*news\s+(?:about|on|regarding)\s+(.+?)\s*[?.!]*\s*$/i,
    // "what's happening / what's new with X" (contracted + uncontracted)
    /\b(?:what'?s|whats|what\s+is)\s+(?:happening|new|going\s+on)\s+(?:with|in|on)\s+(.+?)\s*[?.!]*\s*$/i,
    // "have you heard / did you hear about X"
    /\b(?:have\s+you\s+heard|did\s+you\s+hear)\s+(?:anything\s+)?(?:about|on|regarding)\s+(.+?)\s*[?.!]*\s*$/i,
    // "recent updates/changes/news on X"
    /\brecent\s+(?:updates?|changes|news|developments?)\s+(?:about|on|with|for|in)\s+(.+?)\s*[?.!]*\s*$/i,
    // "what happened to / with X" — past-tense state-change query
    /\bwhat\s+happened\s+(?:to|with)\s+(.+?)\s*[?.!]*\s*$/i,
    // "is X out yet" / "is X released yet" — release-status query
    /\b(?:is|are)\s+(.+?)\s+(?:out|released|launched|live)\s+yet\s*[?.!]*\s*$/i,
    // "did/has X release / come out / launch / drop"
    /\b(?:did|has|have)\s+(.+?)\s+(?:come\s+out|released?|launched?|dropped?)(?:\s+yet)?\s*[?.!]*\s*$/i,
    // "what's the X meta/state/situation right now / today / this week / as of today"
    /\b(?:what'?s|whats|how'?s|hows|what\s+is|how\s+is)\s+(.+?)\s+(?:right\s+now|today|this\s+(?:week|month)|currently|as\s+of\s+(?:today|now|this\s+week))\s*[?.!]*\s*$/i,
];
/**
 * Topics that name themselves but resolve to "ask the prior turn." Arbiter
 * cannot disambiguate these from surface text — the LLM-direct path can,
 * because it has the transcript. Reject so the request falls through.
 */
const PRONOUN_TOPICS = new Set([
    "that",
    "this",
    "it",
    "them",
    "those",
    "these",
    "him",
    "her",
    "us",
    "you",
    "me",
    "myself",
    "yourself",
    "themselves",
    "it all",
    "all that",
    "the situation",
    "the matter",
    "everything",
    "things",
]);
export function parseNewsSearch(text) {
    for (const pattern of NEWS_PATTERNS) {
        const m = pattern.exec(text);
        if (m === null)
            continue;
        const raw = trimTerminalPunct(m[1]?.trim() ?? "");
        if (raw.length === 0)
            return null;
        // Reject pronoun-only topics — they require conversation context
        // we don't have here.
        if (PRONOUN_TOPICS.has(raw.toLowerCase()))
            return null;
        // Reject path-traversal / file-system tokens — keeps the search
        // query free of obvious injection attempts.
        if (looksLikePathInjection(raw))
            return null;
        // Effect-class follows the same allowlist gate parseWebSearch uses,
        // so news queries respect ARBITER_SEARCH_ALLOWLIST consistently.
        const effectClass = searchAllowlist().length > 0 ? "search" : "network";
        return {
            action: "web_search",
            effectClass,
            params: { query: raw },
        };
    }
    return null;
}
//# sourceMappingURL=news-search.js.map