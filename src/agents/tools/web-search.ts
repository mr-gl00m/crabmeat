/**
 * web_search — agent-driven web search with provider auto-selection.
 *
 * Providers are tried in order based on which environment secret is set:
 *   1. Tavily      (TAVILY_API_KEY)       — best quality for agents
 *   2. Brave       (BRAVE_SEARCH_API_KEY) — paid but generous free tier
 *   3. DuckDuckGo  (no key)               — zero-config HTML fallback
 *
 * The no-key DuckDuckGo path exists so the tool works out of the box for
 * users who haven't configured any search provider. It is intentionally
 * fragile — DDG HTML layout changes without notice. Users who rely on
 * web_search should set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY.
 *
 * The LLM sees `query`, optional `count`, and an optional `topic` of
 * 'general' (default) or 'news'. The news vertical exists because
 * general web search returns mostly homepages and section indexes for
 * news-y queries ("election headlines", "marvel rivals patch notes")
 * — precisely the workload where the agent most needs specific dated
 * articles. Tavily exposes this as `topic: "news"` natively; Brave has
 * a separate `/res/v1/news/search` endpoint we route to.
 *
 * Provider selection is a runtime concern the agent should not have to
 * reason about, but we DO let it force one via `provider` when needed.
 */

type SearchTopic = "general" | "news";
const DEFAULT_NEWS_DAYS = 3;

import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { isNewsQuery } from "../news-shape.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";

type BuiltinResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

const SEARCH_TIMEOUT_MS = 15_000;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MAX_QUERY_LEN = 400;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── Provider: Tavily ────────────────────────────────────

async function searchTavily(
  query: string,
  count: number,
  apiKey: string,
  topic: SearchTopic,
  days: number,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CrabMeat/0.1.0 (AI Gateway)",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: count,
        search_depth: "basic",
        // topic=news enables Tavily's news vertical: dated articles from
        // news sources, sorted by recency. days bounds the recency window.
        // We omit days from general searches because it's not meaningful
        // and Tavily warns about ignoring it.
        topic,
        ...(topic === "news" ? { days } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Tavily HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? []).slice(0, count).map((r) => ({
      title: (r.title ?? "").trim(),
      url: r.url ?? "",
      snippet: (r.content ?? "").trim(),
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider: Brave Search ──────────────────────────────

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
  topic: SearchTopic,
  days: number,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    // Brave splits web and news into separate endpoints with different
    // response shapes. We route by topic. The news endpoint accepts
    // freshness=pd|pw|pm (past day/week/month) which we map from `days`.
    const isNews = topic === "news";
    const endpoint = isNews
      ? "https://api.search.brave.com/res/v1/news/search"
      : "https://api.search.brave.com/res/v1/web/search";
    const freshness = days <= 1 ? "pd" : days <= 7 ? "pw" : "pm";
    const url =
      `${endpoint}?q=${encodeURIComponent(query)}&count=${count}` +
      (isNews ? `&freshness=${freshness}` : "");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
        "User-Agent": "CrabMeat/0.1.0 (AI Gateway)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Brave HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }
    if (isNews) {
      // News endpoint returns { results: [{title, url, description, age, ...}] }
      // at the top level (no `web` wrapper).
      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
      return (data.results ?? []).slice(0, count).map((r) => ({
        title: stripHtml(r.title ?? "").trim(),
        url: r.url ?? "",
        snippet:
          (r.age ? `[${r.age}] ` : "") + stripHtml(r.description ?? "").trim(),
      }));
    }
    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
        }>;
      };
    };
    return (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: stripHtml(r.title ?? "").trim(),
      url: r.url ?? "",
      snippet: stripHtml(r.description ?? "").trim(),
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider: DuckDuckGo HTML (zero-config fallback) ────

async function searchDuckDuckGo(
  query: string,
  count: number,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        // DDG rejects the default fetch UA; use a real browser string.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDuckDuckGoHtml(html, count);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse DDG HTML results with targeted regex. Avoids a cheerio dependency
 * for a single consumer. Brittle by design: if DDG changes layout we fall
 * back to "no results" rather than crashing, and the user should add an
 * API key.
 */
function parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result block contains: a result__a anchor (title+href) and a
  // result__snippet anchor. Capture all three in one pass.
  const pattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && results.length < count) {
    const rawUrl = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawSnippet = match[3] ?? "";
    const url = decodeDuckDuckGoUrl(rawUrl);
    if (!url) continue;
    const title = stripHtml(rawTitle).trim();
    if (!title) continue;
    results.push({
      title,
      url,
      snippet: stripHtml(rawSnippet).trim(),
    });
  }
  return results;
}

/**
 * DDG HTML results route through //duckduckgo.com/l/?uddg=<encoded>.
 * Unwrap to the real URL so the agent can cite or follow it directly.
 */
function decodeDuckDuckGoUrl(raw: string): string {
  try {
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
    const parsed = new URL(absolute);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return absolute;
  } catch {
    return raw;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── Handler ─────────────────────────────────────────────

/**
 * Heuristic: does a query look like the user is asking for current
 * news/headlines/recent events? Used to auto-promote the topic to "news"
 * when the agent doesn't set it explicitly. Shared with the tool-need
 * classifier (see news-shape.ts) so the classifier's "tell the model
 * to call web_search" decision and the tool's "call the news vertical"
 * decision agree on the same prompt — drift between the two used to
 * mean the model got told to call the tool but the tool returned weaker
 * general-vertical results.
 */
function looksLikeNewsQuery(query: string): boolean {
  return isNewsQuery(query).matched;
}

async function handleWebSearch(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    return { content: "web_search: 'query' is required.", isError: true };
  }
  if (query.length > MAX_QUERY_LEN) {
    return {
      content: `web_search: query too long (${query.length} > ${MAX_QUERY_LEN}).`,
      isError: true,
    };
  }

  let count = DEFAULT_RESULTS;
  if (typeof params.count === "number" && Number.isFinite(params.count)) {
    count = Math.max(MIN_RESULTS, Math.min(MAX_RESULTS, Math.round(params.count)));
  }

  // Topic resolution: explicit param wins, otherwise auto-promote to
  // "news" for queries that obviously want recent dated articles. The
  // auto-promote loophole means an agent can stay lazy and the right
  // thing usually happens, while explicit topic="general" still works
  // as a manual override.
  const explicitTopicRaw =
    typeof params.topic === "string" ? params.topic.toLowerCase() : "";
  let topic: SearchTopic;
  if (explicitTopicRaw === "news") topic = "news";
  else if (explicitTopicRaw === "general") topic = "general";
  else topic = looksLikeNewsQuery(query) ? "news" : "general";

  let days = DEFAULT_NEWS_DAYS;
  if (typeof params.days === "number" && Number.isFinite(params.days)) {
    days = Math.max(1, Math.min(30, Math.round(params.days)));
  }

  const explicit =
    typeof params.provider === "string" ? params.provider.toLowerCase() : "";
  const tavilyKey = process.env.TAVILY_API_KEY;
  const braveKey =
    process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY;

  let provider: "tavily" | "brave" | "duckduckgo";
  if (explicit === "tavily" || (!explicit && tavilyKey)) provider = "tavily";
  else if (explicit === "brave" || (!explicit && braveKey)) provider = "brave";
  else provider = "duckduckgo";

  // DDG fallback has no real news vertical. We log a warning when news
  // mode is requested against DDG so the user understands why result
  // quality is poor — the fix is a Tavily or Brave key.
  if (provider === "duckduckgo" && topic === "news") {
    logger.warn(
      { query, provider },
      "web_search: news topic requested but no Tavily/Brave key — DDG fallback has no news vertical, results will be web-search quality",
    );
  }

  try {
    let results: SearchResult[];
    switch (provider) {
      case "tavily":
        if (!tavilyKey) {
          return {
            content: "web_search: TAVILY_API_KEY is not set.",
            isError: true,
          };
        }
        results = await searchTavily(query, count, tavilyKey, topic, days);
        break;
      case "brave":
        if (!braveKey) {
          return {
            content: "web_search: BRAVE_SEARCH_API_KEY is not set.",
            isError: true,
          };
        }
        results = await searchBrave(query, count, braveKey, topic, days);
        break;
      default:
        results = await searchDuckDuckGo(query, count);
        break;
    }

    if (results.length === 0) {
      return {
        content: `No search results for '${query}' (provider: ${provider}, topic: ${topic}).`,
        outputs: { query, provider, topic, results: [], count: 0 },
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || "(no snippet)"}`,
      )
      .join("\n\n");

    return {
      content: `Search results for '${query}' (${provider}, topic=${topic}):\n\n${formatted}`,
      outputs: { query, provider, topic, results, count: results.length },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.toLowerCase().includes("abort")) {
      return {
        content: `web_search: timed out after ${SEARCH_TIMEOUT_MS}ms (provider: ${provider}).`,
        isError: true,
      };
    }
    logger.warn({ provider, topic, error: msg }, "web_search provider failure");
    return {
      content: `web_search failed (${provider}): ${msg}`,
      isError: true,
    };
  }
}

// ── Registration ────────────────────────────────────────

export function registerWebSearchTool(): void {
  registerToolHandler("web_search", handleWebSearch);
  registerPromptFragment({
    id: "tool:web-research",
    category: "tool",
    // Rule applies whenever any web-facing research tool is present —
    // web_search, web_fetch, or browser all produce information that
    // needs attribution.
    predicate: (ctx) =>
      ctx.tools.includes("web_search") ||
      ctx.tools.includes("web_fetch") ||
      ctx.tools.includes("browser"),
    order: 20,
    content: [
      "CITE YOUR SOURCES: When you use web_search, web_fetch, or the browser",
      "tool to gather news or information, always cite the URLs you pulled from",
      'in your final summary. Prefer an inline format like "...according to',
      '[example.com](https://example.com/path)" or a short sources list at the',
      "end. Do not paraphrase facts from the web without naming the source — the",
      "user needs to verify and follow up. This applies to every research task,",
      "not just formal reports.",
    ].join("\n"),
  });
  logger.info({ tools: ["web_search"] }, "web_search tool registered");

  // Loud one-time warning at registration time if neither Tavily nor Brave
  // is configured. DDG HTML-scrape fallback works but returns aggregator
  // junk for news/current-events queries — the exact workload where
  // web_search matters most. Surfacing this at boot (not burying it in a
  // per-call log) means the user sees it on every gateway start until
  // they fix it, which is the right level of nagging for a quality wall.
  const tavilyKey = process.env.TAVILY_API_KEY;
  const braveKey =
    process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY;
  if (!tavilyKey && !braveKey) {
    logger.warn(
      {
        provider: "duckduckgo-html-fallback",
        fix: "set TAVILY_API_KEY (free tier at https://tavily.com, best for agents) or BRAVE_SEARCH_API_KEY",
      },
      "web_search: no search API key configured — using brittle DuckDuckGo HTML scraper. News/current-events queries will return poor results. Set TAVILY_API_KEY for production-quality search.",
    );
  } else {
    logger.info(
      { provider: tavilyKey ? "tavily" : "brave" },
      "web_search: search API key detected",
    );
  }
}

// Exported for tests
export {
  handleWebSearch as _handleWebSearch,
  parseDuckDuckGoHtml as _parseDuckDuckGoHtml,
  decodeDuckDuckGoUrl as _decodeDuckDuckGoUrl,
  stripHtml as _stripHtml,
};
