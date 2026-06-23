/**
 * Content classification for the refusal-interception layer.
 *
 * The gate that decides whether a detected refusal should be rerouted
 * to a fallback model. Two inputs:
 *
 *   1. User-tag override — the user explicitly marks their request
 *      with a class (e.g. via `/class adult-creative` or an inline
 *      hint). Always wins.
 *
 *   2. Keyword heuristic — if no tag, scan the prompt for
 *      class-associated keywords. Brittle but predictable; the tradeoff
 *      is acceptable given that rerouting on a wrong class just falls
 *      back to a more capable local model — the failure mode is
 *      "non-optimal routing," not "broken safety."
 *
 * The allowlist itself lives in crabmeat.json. Classes OUTSIDE the
 * allowlist never reroute — refusals stay refused. This is deliberate
 * and matches the principle that "treat user like an adult" means "the
 * adult user decides their own lines," not "no lines anywhere."
 */

/** Free-form class label. The allowlist in config is the source of truth. */
export type ContentClass = string;

export interface ClassificationResult {
  contentClass: ContentClass | null;
  source: "user-tag" | "keyword" | "none";
  matchedKeyword?: string;
}

/**
 * Keyword → class mapping. Lowercase; the haystack is lowercased once.
 * Order matters: the first match wins. Put more specific keywords first
 * (e.g. "adult club" before "club" — though we don't ship "club" alone
 * because it would swallow board meetings and sports clubs).
 *
 * Keep this list tight. Every entry is a false-positive surface; broad
 * keywords ("sex", "adult") route huge swaths of legit queries through
 * the fallback model unnecessarily. Specific multi-word phrases are the
 * sweet spot.
 */
const DEFAULT_KEYWORD_MAP: ReadonlyArray<[string, ContentClass]> = [
  // nsfw-search — real-world lookups that models routinely refuse
  ["strip club", "nsfw-search"],
  ["adult club", "nsfw-search"],
  ["gentlemen's club", "nsfw-search"],
  ["escort service", "nsfw-search"],
  ["adult bookstore", "nsfw-search"],

  // adult-creative — fiction / creative writing with explicit content
  ["erotic fiction", "adult-creative"],
  ["erotic story", "adult-creative"],
  ["smut", "adult-creative"],
  ["nsfw writing", "adult-creative"],
  ["explicit fiction", "adult-creative"],
  ["erotic roleplay", "adult-creative"],

  // edgy-humor — dark/offensive jokes, not slurs-against-real-people
  ["dark joke", "edgy-humor"],
  ["offensive joke", "edgy-humor"],
  ["edgy joke", "edgy-humor"],
  ["roast me", "edgy-humor"],

  // security-research — red-team / pentest / CTF territory
  ["reverse shell", "security-research"],
  ["exploit payload", "security-research"],
  ["pentest", "security-research"],
  ["ctf challenge", "security-research"],
  ["privilege escalation", "security-research"],
  ["shellcode", "security-research"],

  // substance-info — harm-reduction questions models reflexively refuse
  ["drug interaction", "substance-info"],
  ["harm reduction", "substance-info"],
  ["safe dosage", "substance-info"],
];

/**
 * Classify a user prompt. If `userTag` is supplied, it wins
 * unconditionally (explicit > heuristic). Otherwise, run the keyword
 * scan. Returns `{ contentClass: null, source: "none" }` when nothing
 * matches — the caller treats that as "do not auto-reroute."
 */
export function classifyContent(
  userPrompt: string,
  userTag?: ContentClass,
): ClassificationResult {
  if (userTag && userTag.trim()) {
    return { contentClass: userTag.trim(), source: "user-tag" };
  }

  const lowered = userPrompt.toLowerCase();
  for (const [keyword, cls] of DEFAULT_KEYWORD_MAP) {
    if (lowered.includes(keyword)) {
      return {
        contentClass: cls,
        source: "keyword",
        matchedKeyword: keyword,
      };
    }
  }

  return { contentClass: null, source: "none" };
}

/**
 * Given a classification result and the user's configured allowlist,
 * decide whether a detected refusal on this request is allowed to
 * reroute to a fallback model. Unclassified requests never reroute.
 */
export function isAllowedToReroute(
  result: ClassificationResult,
  allowlist: readonly ContentClass[],
): boolean {
  if (!result.contentClass) return false;
  return allowlist.includes(result.contentClass);
}
