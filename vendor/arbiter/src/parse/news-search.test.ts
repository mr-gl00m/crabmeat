import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseNewsSearch } from "./news-search.js";
import { resetEnv } from "../env.js";

describe("parseNewsSearch — positive cases", () => {
  beforeEach(() => {
    process.env["ARBITER_SEARCH_ALLOWLIST"] = "duckduckgo.com,localhost";
    resetEnv();
  });
  afterEach(() => {
    delete process.env["ARBITER_SEARCH_ALLOWLIST"];
    resetEnv();
  });

  it("matches 'what's the latest on Overwatch'", () => {
    const r = parseNewsSearch("what's the latest on Overwatch");
    expect(r?.action).toBe("web_search");
    expect(r?.params.query).toBe("Overwatch");
  });

  it("matches 'whats the latest news on Marvel Rivals'", () => {
    const r = parseNewsSearch("whats the latest news on Marvel Rivals");
    expect(r?.params.query).toBe("Marvel Rivals");
  });

  it("matches 'any news on the Pokemon VGC meta'", () => {
    const r = parseNewsSearch("any news on the Pokemon VGC meta");
    expect(r?.params.query).toBe("the Pokemon VGC meta");
  });

  it("matches 'recent updates on TypeScript 6'", () => {
    const r = parseNewsSearch("recent updates on TypeScript 6");
    expect(r?.params.query).toBe("TypeScript 6");
  });

  it("matches 'news about the latest patch'", () => {
    const r = parseNewsSearch("news about the latest patch");
    expect(r?.params.query).toBe("the latest patch");
  });

  it("matches 'what's happening with the OpenAI API'", () => {
    const r = parseNewsSearch("what's happening with the OpenAI API");
    expect(r?.params.query).toBe("the OpenAI API");
  });

  it("matches 'what's the Overwatch meta right now'", () => {
    const r = parseNewsSearch("what's the Overwatch meta right now");
    expect(r?.params.query).toBe("the Overwatch meta");
  });

  it("strips trailing punctuation", () => {
    const r = parseNewsSearch("what's the latest on Overwatch?");
    expect(r?.params.query).toBe("Overwatch");
  });
});

describe("parseNewsSearch — negative / anaphora cases", () => {
  beforeEach(() => {
    process.env["ARBITER_SEARCH_ALLOWLIST"] = "duckduckgo.com";
    resetEnv();
  });
  afterEach(() => {
    delete process.env["ARBITER_SEARCH_ALLOWLIST"];
    resetEnv();
  });

  it("rejects pronoun topic 'that' — needs LLM context", () => {
    expect(parseNewsSearch("what's the latest on that")).toBeNull();
    expect(parseNewsSearch("what's the latest on that?")).toBeNull();
    expect(parseNewsSearch("any news on it")).toBeNull();
    expect(parseNewsSearch("recent updates on this")).toBeNull();
  });

  it("rejects when no topic follows the trigger", () => {
    expect(parseNewsSearch("what's the latest")).toBeNull();
    expect(parseNewsSearch("any news?")).toBeNull();
  });

  it("rejects path-traversal injection in topic", () => {
    expect(parseNewsSearch("what's the latest on ../../etc/passwd")).toBeNull();
    expect(parseNewsSearch("any news on /root/secrets")).toBeNull();
  });

  it("does not match plain conversational text", () => {
    expect(parseNewsSearch("hello there")).toBeNull();
    expect(parseNewsSearch("how are you")).toBeNull();
    expect(parseNewsSearch("write me a story")).toBeNull();
  });

  it("does not match bare 'search for X' — that's parseWebSearch's job", () => {
    expect(parseNewsSearch("search for capybara facts")).toBeNull();
  });
});

describe("parseNewsSearch — effectClass follows ARBITER_SEARCH_ALLOWLIST", () => {
  it("emits effectClass=network when allowlist is empty", () => {
    delete process.env["ARBITER_SEARCH_ALLOWLIST"];
    resetEnv();
    const r = parseNewsSearch("what's the latest on Overwatch");
    expect(r?.effectClass).toBe("network");
  });

  it("emits effectClass=search when allowlist is non-empty", () => {
    process.env["ARBITER_SEARCH_ALLOWLIST"] = "tavily.com";
    resetEnv();
    try {
      const r = parseNewsSearch("what's the latest on Overwatch");
      expect(r?.effectClass).toBe("search");
    } finally {
      delete process.env["ARBITER_SEARCH_ALLOWLIST"];
      resetEnv();
    }
  });
});
