import { describe, it, expect } from "vitest";
import { classifyToolNeed, toolNeedGuidance } from "./tool-need-classifier.js";

describe("classifyToolNeed", () => {
  it("triggers on 'what's the latest on Overwatch'", () => {
    const r = classifyToolNeed("what's the latest on Overwatch");
    expect(r.tool).toBe("web_search");
    expect(r.matchedTrigger).toBe("what's the latest");
  });

  it("triggers on anaphoric 'what's the latest on that' (where arbiter would refuse)", () => {
    const r = classifyToolNeed("what's the latest on that?");
    expect(r.tool).toBe("web_search");
  });

  it("triggers on 'any news on Marvel Rivals'", () => {
    const r = classifyToolNeed("any news on Marvel Rivals");
    expect(r.tool).toBe("web_search");
    expect(r.matchedTrigger).toBe("any news");
  });

  it("triggers on 'recent updates' phrasing", () => {
    expect(classifyToolNeed("recent updates on TypeScript").tool).toBe("web_search");
  });

  it("triggers on 'patch notes' / 'current meta'", () => {
    expect(classifyToolNeed("any patch notes worth reading").tool).toBe("web_search");
    expect(classifyToolNeed("what is the current meta in Pokemon VGC").tool).toBe("web_search");
  });

  it("triggers on 'right now' as a recency marker", () => {
    expect(classifyToolNeed("how is the dollar doing right now").tool).toBe("web_search");
  });

  it("does not trigger on plain conversational text", () => {
    expect(classifyToolNeed("hello there").tool).toBeNull();
    expect(classifyToolNeed("how are you").tool).toBeNull();
    expect(classifyToolNeed("write me a story").tool).toBeNull();
  });

  it("does not trigger on factual questions without recency markers", () => {
    expect(classifyToolNeed("what is the speed of light").tool).toBeNull();
    expect(classifyToolNeed("explain monads").tool).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyToolNeed("WHATS THE LATEST ON ANYTHING").tool).toBe("web_search");
  });
});

describe("toolNeedGuidance", () => {
  it("produces a non-empty guidance block for web_search", () => {
    const g = toolNeedGuidance("web_search", "cap_test123abc");
    expect(g).toContain("TOOL GUIDANCE");
    expect(g).toContain("cap_test123abc");
    expect(g).toContain("MUST");
  });

  it("does NOT mention the human tool name as the call target", () => {
    // Regression for 2026-04-30 incident: guidance hardcoded "web_search"
    // by name, model called it by name, validator rejected with
    // "Unknown capability ID 'web_search'", model spun out into a
    // Pokemon-patch-notes confabulation cascade.
    const g = toolNeedGuidance("web_search", "cap_real456def");
    // The descriptive aside ("the web search tool") is fine, but the
    // function-name token must be the cap ID, not a bare "web_search".
    expect(g).not.toMatch(/`web_search`/);
    expect(g).toContain("`cap_real456def`");
  });
});
