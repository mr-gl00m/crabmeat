/**
 * Unit tests for the prompt-fragment registry.
 *
 * Registry itself is dumb — the tests lock in the contract:
 *   - Idempotent by id
 *   - Predicate-driven inclusion (no global match)
 *   - Deterministic ordering (category rank → order field → id)
 *   - Broken predicates don't poison the build
 *   - Empty trivia: no fragments means empty string out
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPromptFragment,
  listFragments,
  composeFragments,
  _resetFragmentRegistry,
  _allFragments,
  type FragmentContext,
} from "./prompt-fragments.js";

const emptyCtx: FragmentContext = {
  tools: [],
  availableOutboundConnectors: [],
};

beforeEach(() => {
  _resetFragmentRegistry();
});

describe("registerPromptFragment", () => {
  it("stores a fragment and returns it via _allFragments", () => {
    registerPromptFragment({
      id: "test:one",
      category: "universal",
      predicate: () => true,
      content: "hello world",
    });
    expect(_allFragments()).toHaveLength(1);
    expect(_allFragments()[0]!.id).toBe("test:one");
  });

  it("is idempotent by id — a second registration replaces the first", () => {
    registerPromptFragment({
      id: "test:one",
      category: "universal",
      predicate: () => true,
      content: "first",
    });
    registerPromptFragment({
      id: "test:one",
      category: "universal",
      predicate: () => true,
      content: "second",
    });
    expect(_allFragments()).toHaveLength(1);
    expect(_allFragments()[0]!.content).toBe("second");
  });

  it("refuses a fragment with no id", () => {
    expect(() =>
      registerPromptFragment({
        id: "",
        category: "universal",
        predicate: () => true,
        content: "x",
      }),
    ).toThrow(/id is required/);
  });

  it("refuses a fragment with empty content", () => {
    expect(() =>
      registerPromptFragment({
        id: "test:blank",
        category: "universal",
        predicate: () => true,
        content: "   ",
      }),
    ).toThrow(/content is empty/);
  });
});

describe("listFragments — predicate gating", () => {
  it("returns only fragments whose predicate matches the context", () => {
    registerPromptFragment({
      id: "tool:timer",
      category: "tool",
      predicate: (c) => c.tools.includes("timer"),
      content: "timer rule",
    });
    registerPromptFragment({
      id: "tool:random",
      category: "tool",
      predicate: (c) => c.tools.includes("random"),
      content: "random rule",
    });

    const result = listFragments({
      tools: ["timer"],
      availableOutboundConnectors: [],
    });
    expect(result.map((f) => f.id)).toEqual(["tool:timer"]);
  });

  it("a broken predicate is logged-and-excluded, not thrown", () => {
    registerPromptFragment({
      id: "tool:boom",
      category: "tool",
      predicate: () => {
        throw new Error("predicate exploded");
      },
      content: "should be excluded",
    });
    registerPromptFragment({
      id: "tool:ok",
      category: "tool",
      predicate: () => true,
      content: "should be included",
    });
    const result = listFragments(emptyCtx);
    expect(result.map((f) => f.id)).toEqual(["tool:ok"]);
  });
});

describe("listFragments — ordering", () => {
  it("renders universal before tool before channel", () => {
    registerPromptFragment({
      id: "z-channel",
      category: "channel",
      predicate: () => true,
      content: "c",
    });
    registerPromptFragment({
      id: "a-tool",
      category: "tool",
      predicate: () => true,
      content: "t",
    });
    registerPromptFragment({
      id: "m-universal",
      category: "universal",
      predicate: () => true,
      content: "u",
    });
    const result = listFragments(emptyCtx).map((f) => f.category);
    expect(result).toEqual(["universal", "tool", "channel"]);
  });

  it("within a category, sorts by order field ascending", () => {
    registerPromptFragment({
      id: "tool:b",
      category: "tool",
      order: 200,
      predicate: () => true,
      content: "b",
    });
    registerPromptFragment({
      id: "tool:a",
      category: "tool",
      order: 100,
      predicate: () => true,
      content: "a",
    });
    const result = listFragments(emptyCtx).map((f) => f.id);
    expect(result).toEqual(["tool:a", "tool:b"]);
  });

  it("ties on order break by id ascending (deterministic)", () => {
    registerPromptFragment({
      id: "tool:zulu",
      category: "tool",
      predicate: () => true,
      content: "z",
    });
    registerPromptFragment({
      id: "tool:alpha",
      category: "tool",
      predicate: () => true,
      content: "a",
    });
    const result = listFragments(emptyCtx).map((f) => f.id);
    expect(result).toEqual(["tool:alpha", "tool:zulu"]);
  });
});

describe("composeFragments", () => {
  it("returns empty string when no fragments apply", () => {
    expect(composeFragments(emptyCtx)).toBe("");
  });

  it("joins selected fragments with a blank line between them", () => {
    registerPromptFragment({
      id: "universal:a",
      category: "universal",
      predicate: () => true,
      content: "first block",
    });
    registerPromptFragment({
      id: "universal:b",
      category: "universal",
      predicate: () => true,
      content: "second block",
    });
    const out = composeFragments(emptyCtx);
    // Exactly one blank line between blocks.
    expect(out).toBe("first block\n\nsecond block");
  });

  it("respects predicate — a gated-out fragment doesn't appear", () => {
    registerPromptFragment({
      id: "tool:on",
      category: "tool",
      predicate: (c) => c.tools.includes("on"),
      content: "tool ON rule",
    });
    registerPromptFragment({
      id: "tool:off",
      category: "tool",
      predicate: (c) => c.tools.includes("off"),
      content: "tool OFF rule",
    });
    const out = composeFragments({ tools: ["on"], availableOutboundConnectors: [] });
    expect(out).toContain("tool ON rule");
    expect(out).not.toContain("tool OFF rule");
  });

  it("matches channel fragments against ctx.inboundChannel", () => {
    registerPromptFragment({
      id: "channel:email-imap",
      category: "channel",
      predicate: (c) => c.inboundChannel === "email-imap",
      content: "email rules",
    });
    const withChannel = composeFragments({
      tools: [],
      availableOutboundConnectors: [],
      inboundChannel: "email-imap",
    });
    expect(withChannel).toContain("email rules");

    const withoutChannel = composeFragments(emptyCtx);
    expect(withoutChannel).toBe("");

    const otherChannel = composeFragments({
      tools: [],
      availableOutboundConnectors: [],
      inboundChannel: "discord",
    });
    expect(otherChannel).toBe("");
  });
});
