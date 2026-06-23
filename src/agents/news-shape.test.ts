import { describe, it, expect } from "vitest";
import { isNewsQuery, NEWS_TRIGGERS } from "./news-shape.js";

describe("isNewsQuery", () => {
  it("matches explicit recency phrasing", () => {
    expect(isNewsQuery("what's the latest on Overwatch").matched).toBe(true);
    expect(isNewsQuery("what's happening with the OpenAI API").matched).toBe(true);
    expect(isNewsQuery("recent updates on TypeScript 6").matched).toBe(true);
  });

  it("matches anaphoric phrasing (where arbiter would refuse)", () => {
    expect(isNewsQuery("what's the latest on that?").matched).toBe(true);
    expect(isNewsQuery("any news on it").matched).toBe(true);
  });

  it("matches news-vertical triggers (headlines, breaking, current events)", () => {
    expect(isNewsQuery("show me today's headlines").matched).toBe(true);
    expect(isNewsQuery("any breaking news on the election").matched).toBe(true);
    expect(isNewsQuery("current events in Japan").matched).toBe(true);
  });

  it("matches release-status / past-tense state-change phrasing", () => {
    expect(isNewsQuery("is GTA 6 out yet").matched).toBe(true);
    expect(isNewsQuery("what happened to Twitter").matched).toBe(true);
    expect(isNewsQuery("any release date for the new iPhone").matched).toBe(true);
  });

  it("matches conversational news pickups", () => {
    expect(isNewsQuery("have you heard about the layoffs").matched).toBe(true);
    expect(isNewsQuery("did you hear about Tesla's earnings").matched).toBe(true);
  });

  it("does not match plain conversational text", () => {
    expect(isNewsQuery("hello there").matched).toBe(false);
    expect(isNewsQuery("how are you").matched).toBe(false);
    expect(isNewsQuery("write me a story about dragons").matched).toBe(false);
  });

  it("does not match non-news factual questions", () => {
    expect(isNewsQuery("what is the speed of light").matched).toBe(false);
    expect(isNewsQuery("explain monads").matched).toBe(false);
  });

  it("returns the matched trigger for diagnostics", () => {
    const r = isNewsQuery("any news on Marvel Rivals");
    expect(r.matched).toBe(true);
    expect(r.trigger).toBe("any news");
  });

  it("is case-insensitive", () => {
    expect(isNewsQuery("WHATS THE LATEST").matched).toBe(true);
  });

  it("multi-word triggers win over their substrings (order matters in NEWS_TRIGGERS)", () => {
    // "any news" should match before bare "news on" would, because the
    // list is ordered most-specific-first and reports the more specific
    // match for clearer logs.
    const r = isNewsQuery("any news on Overwatch");
    expect(r.trigger).toBe("any news");
  });

  it("exposes NEWS_TRIGGERS for cross-module verification", () => {
    expect(NEWS_TRIGGERS.length).toBeGreaterThan(20);
    expect(NEWS_TRIGGERS).toContain("breaking news");
    expect(NEWS_TRIGGERS).toContain("any news");
  });
});
