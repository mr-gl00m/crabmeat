import { describe, it, expect } from "vitest";
import type { MindshardData, MemoryEntry } from "../agents/soulshard.js";
import {
  tagOverlap,
  selectStmToLtmCandidates,
  selectLtmToCoreCandidates,
  selectPruneCandidates,
  planConsolidation,
  applyPlan,
  DEFAULT_PROMOTION_RULES,
  type PromotionRuleConfig,
} from "./cortex-tiers.js";

// Rift entries don't carry sessions_held in the TS MindshardData
// schema, so tests fabricate a Map from entry_title → held count
// and pass it via the age estimator. Mirrors how a host project
// would wire its own session bookkeeping.
function makeRules(
  heldByTitle: Record<string, number> = {},
  overrides: Partial<Omit<PromotionRuleConfig, "estimateSessionsHeld">> = {},
): PromotionRuleConfig {
  return {
    ...DEFAULT_PROMOTION_RULES,
    ...overrides,
    estimateSessionsHeld: (entry: MemoryEntry) =>
      heldByTitle[entry.entry_title ?? ""] ?? 0,
  };
}

function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    entry_title: "untitled",
    strength: 0.5,
    tags: [],
    ...partial,
  };
}

describe("cortex-tiers", () => {
  describe("tagOverlap", () => {
    it("returns 0 for empty or missing inputs", () => {
      expect(tagOverlap([], ["a"])).toBe(0);
      expect(tagOverlap(["a"], [])).toBe(0);
      expect(tagOverlap(undefined, ["a"])).toBe(0);
      expect(tagOverlap(["a"], undefined)).toBe(0);
    });

    it("counts overlapping tags case-insensitively", () => {
      expect(tagOverlap(["A", "b", "C"], ["a", "c"])).toBe(2);
    });

    it("does not double-count duplicates", () => {
      // a appears twice on the left, but "b" only exists in both inputs
      // (there is no "b" on the right here, so overlap is 1 from "a")
      expect(tagOverlap(["a", "a"], ["a"])).toBe(2);
      // Intentional note: this mirrors how Python's _tag_overlap works
      // in Rift — it counts occurrences in `a` that appear in `b`.
    });
  });

  describe("selectStmToLtmCandidates", () => {
    it("returns empty when STM is missing", () => {
      const mindshard: MindshardData = {};
      const rules = makeRules();
      expect(selectStmToLtmCandidates(mindshard, rules)).toEqual([]);
    });

    it("promotes entries that have been held long enough", () => {
      const mindshard: MindshardData = {
        short_term: {
          slots: [
            entry({ entry_title: "old", strength: 0.8 }),
            entry({ entry_title: "new", strength: 0.9 }),
          ],
        },
      };
      const rules = makeRules({ old: 5, new: 1 }, { minSessionsInStm: 3 });
      const candidates = selectStmToLtmCandidates(mindshard, rules);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.entry.entry_title).toBe("old");
      expect(candidates[0]!.reason).toContain("held in STM for 5");
    });

    it("sorts candidates by strength descending", () => {
      const mindshard: MindshardData = {
        short_term: {
          slots: [
            entry({ entry_title: "weak", strength: 0.3 }),
            entry({ entry_title: "strong", strength: 0.9 }),
            entry({ entry_title: "mid", strength: 0.6 }),
          ],
        },
      };
      const rules = makeRules({ weak: 10, strong: 10, mid: 10 });
      const candidates = selectStmToLtmCandidates(mindshard, rules);
      expect(candidates.map((c) => c.entry.entry_title)).toEqual([
        "strong",
        "mid",
        "weak",
      ]);
    });
  });

  describe("selectLtmToCoreCandidates", () => {
    it("requires minimum tag overlap with conversation", () => {
      const mindshard: MindshardData = {
        long_term: {
          slots: [
            entry({ entry_title: "match", tags: ["trust", "loss"], strength: 0.7 }),
            entry({ entry_title: "nomatch", tags: ["cooking"], strength: 0.9 }),
          ],
        },
      };
      const rules = makeRules({}, { minTagOverlap: 2 });
      const candidates = selectLtmToCoreCandidates(
        mindshard,
        ["trust", "loss", "fear"],
        rules,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.entry.entry_title).toBe("match");
    });

    it("scores by strength × overlap", () => {
      const mindshard: MindshardData = {
        long_term: {
          slots: [
            entry({ entry_title: "a", tags: ["x", "y"], strength: 0.5 }),
            entry({ entry_title: "b", tags: ["x", "y", "z"], strength: 0.5 }),
          ],
        },
      };
      const rules = makeRules();
      const candidates = selectLtmToCoreCandidates(
        mindshard,
        ["x", "y", "z"],
        rules,
      );
      // "b" has 3 overlap, "a" has 2 — "b" wins
      expect(candidates[0]!.entry.entry_title).toBe("b");
    });
  });

  describe("selectPruneCandidates", () => {
    it("flags STM and LTM entries below retention floor", () => {
      const mindshard: MindshardData = {
        short_term: {
          slots: [entry({ entry_title: "s_weak", strength: 0.05 })],
        },
        long_term: {
          slots: [
            entry({ entry_title: "l_weak", strength: 0.1 }),
            entry({ entry_title: "l_ok", strength: 0.5 }),
          ],
        },
      };
      const rules = makeRules({}, { minStrengthToRetain: 0.2 });
      const candidates = selectPruneCandidates(mindshard, rules);
      const titles = candidates.map((c) => c.entry.entry_title).sort();
      expect(titles).toEqual(["l_weak", "s_weak"]);
    });

    it("never flags core entries", () => {
      const mindshard: MindshardData = {
        core: [{ directive: "always x", strength: 0.01, locked: true }],
      };
      const rules = makeRules({}, { minStrengthToRetain: 0.5 });
      expect(selectPruneCandidates(mindshard, rules)).toEqual([]);
    });
  });

  describe("planConsolidation", () => {
    it("produces a plan with all three buckets", () => {
      const mindshard: MindshardData = {
        short_term: {
          slots: [
            entry({ entry_title: "ripe", strength: 0.8 }),
            entry({ entry_title: "trash", strength: 0.05 }),
          ],
        },
        long_term: {
          slots: [
            entry({ entry_title: "core_ready", tags: ["a", "b"], strength: 0.9 }),
          ],
        },
        core: [{ directive: "locked in", strength: 0.9 }],
      };
      const rules = makeRules(
        { ripe: 10, trash: 0 },
        { minSessionsInStm: 3, minTagOverlap: 2, minStrengthToRetain: 0.2 },
      );
      const plan = planConsolidation(mindshard, ["a", "b"], rules);
      expect(plan.stmToLtm).toHaveLength(1);
      expect(plan.ltmToCore).toHaveLength(1);
      expect(plan.toArchive).toHaveLength(1);
      expect(plan.summary.stmSize).toBe(2);
      expect(plan.summary.ltmSize).toBe(1);
      expect(plan.summary.coreSize).toBe(1);
      expect(plan.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("applyPlan", () => {
    it("throws — not implemented", () => {
      expect(() => applyPlan({}, planConsolidation({}, [], makeRules()))).toThrow(
        /not implemented/,
      );
    });
  });
});
