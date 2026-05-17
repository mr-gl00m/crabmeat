// cortex-tiers — portable scaffolding for STM → LTM → core promotion.
//
// This module is the "brain maintenance" layer's tier-walker and
// promotion-rule engine. It mirrors the Rift memory_manager.py
// pipeline (proj_ai_rift/memory/memory_manager.py) but exposes pure,
// side-effect-free functions over `MindshardData` so it can be
// lifted into other shard projects without taking the CrabMeat
// runtime with it.
//
// Intentionally NOT wired into runCortexDreamIfDue() yet. This is
// scaffolding — present so the next project that adopts it can
// import these functions directly, and so the shape of the eventual
// "apply plan" step is visible at the current layer.
//
// What exists:
//   - ConsolidationPlan type (dry-run description of what would change)
//   - selectStmToLtmCandidates (STM entries eligible for LTM promotion)
//   - selectLtmToCoreCandidates (LTM entries eligible for core promotion)
//   - selectPruneCandidates (weak entries eligible for archival)
//   - planConsolidation (combines the above into a single plan)
//   - tagOverlap helper
//
// What does NOT exist (deliberate — follow-up work):
//   - applyPlan: no MindshardData mutation
//   - saveShard: no ZIP re-write path
//   - Any LLM-backed reflection / summarization step
//
// The Rift pipeline is the reference model:
//   STM → LTM: gate on `sessions_held >= promotion_sessions`
//   LTM → core: gate on tag overlap (>=2) + probabilistic roll
//   Slot competition: full tier evicts weakest; failed promotion archives
//
// The TS MindshardData schema is leaner than Rift's Python — entries
// lack a `sessions_held` field, so the caller supplies an age
// estimator (session counter, timestamp, etc). The promotion rules
// are parameterized to match whatever accounting scheme the host
// project uses.

import type {
  MindshardData,
  MemoryEntry,
} from "../agents/soulshard.js";

// ── Plan types ────────────────────────────────────────────

/**
 * A dry-run description of a tier-maintenance pass. Produced by
 * `planConsolidation`. The caller decides whether to apply it —
 * today, nothing applies plans. Apply is a follow-up that will
 * require shard write-back support in soulshard.ts.
 */
export interface ConsolidationPlan {
  /** STM entries the planner would promote to LTM. */
  stmToLtm: readonly PromotionCandidate[];
  /** LTM entries the planner would promote to core. */
  ltmToCore: readonly PromotionCandidate[];
  /** Entries the planner would archive (prune from their current tier). */
  toArchive: readonly PromotionCandidate[];
  /** Aggregate counters for logging / plan receipts. */
  summary: {
    stmSize: number;
    ltmSize: number;
    coreSize: number;
    stmToLtmCount: number;
    ltmToCoreCount: number;
    archiveCount: number;
  };
  /** ISO timestamp the plan was generated. */
  generatedAt: string;
}

/**
 * A single promotion/archive candidate. Carries the entry itself
 * plus the reason it was selected — useful for logging, receipts,
 * and "what would cortexDream have done?" debugging.
 */
export interface PromotionCandidate {
  entry: MemoryEntry;
  reason: string;
  /** Numeric score used to pick this candidate. Higher = stronger claim. */
  score: number;
}

// ── Rules configuration ───────────────────────────────────

/**
 * Tunables for the promotion rules. Defaults mirror Rift's
 * memory_manager.py constants where possible.
 */
export interface PromotionRuleConfig {
  /** STM→LTM: minimum sessions an entry must live in STM first. */
  minSessionsInStm: number;
  /** LTM→core: minimum conversation tag overlap (default 2). */
  minTagOverlap: number;
  /** Prune: entries below this strength are archive candidates. */
  minStrengthToRetain: number;
  /**
   * Age estimator: given an entry, return how many "sessions" it has
   * existed for. The host project picks the accounting — Rift uses
   * a session counter, CrabMeat could use timestamp diffs. Entries
   * without enough data return 0.
   */
  estimateSessionsHeld: (entry: MemoryEntry) => number;
}

export const DEFAULT_PROMOTION_RULES: Readonly<
  Omit<PromotionRuleConfig, "estimateSessionsHeld">
> = {
  minSessionsInStm: 3,
  minTagOverlap: 2,
  minStrengthToRetain: 0.2,
};

// ── Helpers ───────────────────────────────────────────────

/** Count overlapping tags between two sets. Case-insensitive. */
export function tagOverlap(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): number {
  if (!a?.length || !b?.length) return 0;
  const bLower = new Set(b.map((t) => t.toLowerCase()));
  let n = 0;
  for (const tag of a) {
    if (bLower.has(tag.toLowerCase())) n += 1;
  }
  return n;
}

function entryStrength(entry: MemoryEntry): number {
  return entry.strength ?? 0;
}

// ── Walkers ───────────────────────────────────────────────

/**
 * STM entries eligible for promotion to LTM. Rift rule:
 * `sessions_held >= promotion_sessions`. Strength is carried
 * through as a tiebreaker for slot competition downstream.
 */
export function selectStmToLtmCandidates(
  mindshard: MindshardData,
  rules: PromotionRuleConfig,
): PromotionCandidate[] {
  const slots = mindshard.short_term?.slots ?? [];
  const out: PromotionCandidate[] = [];
  for (const entry of slots) {
    const held = rules.estimateSessionsHeld(entry);
    if (held >= rules.minSessionsInStm) {
      out.push({
        entry,
        reason: `held in STM for ${held} sessions (>= ${rules.minSessionsInStm})`,
        score: entryStrength(entry),
      });
    }
  }
  // Strongest first — matches Rift's weakest-evicted competition.
  return out.sort((a, b) => b.score - a.score);
}

/**
 * LTM entries eligible for promotion to core. Rift rule: tag
 * overlap with current conversation >= `minTagOverlap`. Unlike
 * Rift, this scaffolding does not roll a probabilistic dice —
 * candidate selection is deterministic. The caller can layer
 * randomness on top if desired.
 */
export function selectLtmToCoreCandidates(
  mindshard: MindshardData,
  conversationTags: readonly string[],
  rules: PromotionRuleConfig,
): PromotionCandidate[] {
  const slots = mindshard.long_term?.slots ?? [];
  const out: PromotionCandidate[] = [];
  for (const entry of slots) {
    const overlap = tagOverlap(entry.tags, conversationTags);
    if (overlap >= rules.minTagOverlap) {
      out.push({
        entry,
        reason: `tag overlap ${overlap} with current conversation (>= ${rules.minTagOverlap})`,
        score: entryStrength(entry) * overlap,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Entries (across STM + LTM) below the retention strength. These
 * are archive candidates — "loose memories" the brain lets go of.
 * Core entries are excluded: once something earns core status it
 * is load-bearing identity and must survive a maintenance pass.
 */
export function selectPruneCandidates(
  mindshard: MindshardData,
  rules: PromotionRuleConfig,
): PromotionCandidate[] {
  const out: PromotionCandidate[] = [];
  const scan = (slots: readonly MemoryEntry[] | undefined, origin: string) => {
    for (const entry of slots ?? []) {
      const s = entryStrength(entry);
      if (s < rules.minStrengthToRetain) {
        out.push({
          entry,
          reason: `strength ${s.toFixed(2)} below retention floor ${rules.minStrengthToRetain} (${origin})`,
          score: -s, // weakest first
        });
      }
    }
  };
  scan(mindshard.short_term?.slots, "STM");
  scan(mindshard.long_term?.slots, "LTM");
  return out.sort((a, b) => b.score - a.score);
}

// ── Planner ───────────────────────────────────────────────

/**
 * Build a ConsolidationPlan for the given mindshard. Pure: does
 * not mutate the shard and does not touch the filesystem. Log the
 * plan, write it to a receipts file, or feed it into an apply
 * step — the scaffolding does none of those itself.
 */
export function planConsolidation(
  mindshard: MindshardData,
  conversationTags: readonly string[],
  rules: PromotionRuleConfig,
): ConsolidationPlan {
  const stmToLtm = selectStmToLtmCandidates(mindshard, rules);
  const ltmToCore = selectLtmToCoreCandidates(mindshard, conversationTags, rules);
  const toArchive = selectPruneCandidates(mindshard, rules);

  return {
    stmToLtm,
    ltmToCore,
    toArchive,
    summary: {
      stmSize: mindshard.short_term?.slots?.length ?? 0,
      ltmSize: mindshard.long_term?.slots?.length ?? 0,
      coreSize: mindshard.core?.length ?? 0,
      stmToLtmCount: stmToLtm.length,
      ltmToCoreCount: ltmToCore.length,
      archiveCount: toArchive.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ── Apply (not implemented) ───────────────────────────────

/**
 * Would mutate the mindshard according to a plan, producing a new
 * MindshardData with entries moved/archived. Follow-up work — the
 * apply step needs coordinated shard write-back via a saveShard()
 * that doesn't exist yet. The current module is deliberately
 * planning-only so nothing can mis-write an identity file.
 *
 * See proj_ai_rift/memory/memory_manager.py for the reference
 * apply pipeline: slot competition on full tiers, weakest-evicted,
 * failed-promotion archival.
 */
export function applyPlan(
  _mindshard: MindshardData,
  _plan: ConsolidationPlan,
): MindshardData {
  throw new Error(
    "cortex-tiers: applyPlan not implemented — requires saveShard() support in soulshard.ts",
  );
}
