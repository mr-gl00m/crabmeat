import { trimTerminalPunct } from "./trim.js";
import { looksLikePathInjection } from "./path-jail.js";
import { loadEnv } from "../env.js";
import type { EffectClass, IntentAction } from "../types.js";

const WEB_SEARCH_RE =
  /\b(?:search|google|look\s+up|find|fetch)\s+(?:for\s+|the\s+)?(.+?)\s*$/i;

export interface WebSearchParse {
  readonly action: Extract<IntentAction, "web_search">;
  readonly effectClass: Extract<EffectClass, "search" | "network">;
  readonly params: {
    readonly query: string;
  };
}

export function searchAllowlist(): readonly string[] {
  const raw = loadEnv().ARBITER_SEARCH_ALLOWLIST;
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function parseWebSearch(text: string): WebSearchParse | null {
  const m = WEB_SEARCH_RE.exec(text);
  if (m === null) return null;
  const query = trimTerminalPunct(m[1]?.trim() ?? "");
  if (query.length === 0) return null;
  if (looksLikePathInjection(query)) return null;

  const effectClass: Extract<EffectClass, "search" | "network"> =
    searchAllowlist().length > 0 ? "search" : "network";

  return {
    action: "web_search",
    effectClass,
    params: { query },
  };
}
