/**
 * Prompt-fragment registry.
 *
 * System prompts used to be one giant monolith — the `systemPrompt` field
 * in crabmeat.json held ~6KB of prose covering every topic (email rules,
 * shell rules, timer rules, location rules, browser rules, ...). On small
 * models (Gemma 2B observed 2026-04-24) that wall of text gets skimmed at
 * best and dropped from effective attention at worst.
 *
 * This registry lets rules live with their owners: each tool file
 * registers its own fragment during startup, each connector does the
 * same, and the system-prompt builder only includes the fragments that
 * are actually relevant to the current turn (agent's toolset + inbound
 * channel). A turn that only has three tools active sees only three tool
 * fragments, not the full catalog.
 *
 * The registry is deliberately dumb — a list plus a filter. The smart
 * part is at the registration site (tool/connector authors decide when
 * their rule applies) and the fragment compose call site (caller builds
 * a FragmentContext with the turn's signals).
 *
 * All registration is idempotent by id: re-registering the same id
 * replaces the prior entry. That makes hot-reload during tests safe and
 * prevents duplicate text if a module gets imported twice.
 */

import { logger } from "../infra/logger.js";

/**
 * Signals available to a fragment's predicate. Populated per-turn by the
 * caller (inference pipeline) from the agent config and session.
 */
export interface FragmentContext {
  /** Tool ids available to the agent on this turn. */
  tools: readonly string[];
  /** Inbound connector id (e.g. "email-imap", "discord") — undefined for CLI/direct turns. */
  inboundChannel?: string;
  /** Currently-registered outbound connector ids — live, re-read per turn. */
  availableOutboundConnectors: readonly string[];
}

export type FragmentCategory = "universal" | "tool" | "channel";

export interface PromptFragment {
  /**
   * Unique identifier. Suggested shape: "tool:timer", "channel:email-imap",
   * "universal:verify-before-claiming". Id is used for idempotent
   * re-registration.
   */
  id: string;
  /** Category drives render order: universal → tool → channel. */
  category: FragmentCategory;
  /**
   * Called per-turn with the current FragmentContext. Returns true to
   * include this fragment in the system prompt, false to omit it.
   */
  predicate: (ctx: FragmentContext) => boolean;
  /**
   * The actual prose rendered into the system prompt. No leading or
   * trailing whitespace — the composer joins fragments with a blank
   * line between them.
   */
  content: string;
  /**
   * Secondary sort key within a category. Lower numbers render first.
   * Used to keep related tool fragments clustered deterministically.
   */
  order?: number;
}

const fragments: PromptFragment[] = [];

/**
 * Register a prompt fragment. Idempotent by id — calling twice with the
 * same id replaces the earlier registration. Most callers should invoke
 * this from inside their `registerXTool()` / connector-registration
 * function so registration happens once at startup, not at module load.
 */
export function registerPromptFragment(fragment: PromptFragment): void {
  if (!fragment.id) {
    throw new Error("registerPromptFragment: fragment.id is required");
  }
  if (!fragment.content.trim()) {
    throw new Error(`registerPromptFragment(${fragment.id}): content is empty`);
  }
  const existing = fragments.findIndex((f) => f.id === fragment.id);
  if (existing >= 0) {
    fragments[existing] = fragment;
    logger.debug({ id: fragment.id }, "Prompt fragment replaced");
  } else {
    fragments.push(fragment);
    logger.debug({ id: fragment.id, category: fragment.category }, "Prompt fragment registered");
  }
}

const CATEGORY_RANK: Record<FragmentCategory, number> = {
  universal: 0,
  tool: 1,
  channel: 2,
};

/**
 * Return fragments that apply to the given context, sorted for rendering.
 * Sort order: category rank → `order` field → id (tiebreak).
 */
export function listFragments(ctx: FragmentContext): PromptFragment[] {
  return fragments
    .filter((f) => {
      try {
        return f.predicate(ctx);
      } catch (err) {
        // A broken predicate should never take down the prompt build —
        // log and exclude. The fragment author's bug is the right owner.
        logger.warn(
          { id: f.id, err: err instanceof Error ? err.message : String(err) },
          "Prompt fragment predicate threw — excluding",
        );
        return false;
      }
    })
    .sort((a, b) => {
      const ra = CATEGORY_RANK[a.category];
      const rb = CATEGORY_RANK[b.category];
      if (ra !== rb) return ra - rb;
      const oa = a.order ?? 0;
      const ob = b.order ?? 0;
      if (oa !== ob) return oa - ob;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Compose the selected fragments into a single block of prose for the
 * system prompt. Returns an empty string if no fragments apply — callers
 * should treat an empty string as "nothing to inject."
 */
export function composeFragments(ctx: FragmentContext): string {
  const selected = listFragments(ctx);
  if (selected.length === 0) return "";
  return selected.map((f) => f.content.trim()).join("\n\n");
}

/** For tests — wipe all registered fragments. */
export function _resetFragmentRegistry(): void {
  fragments.length = 0;
}

/** For tests / diagnostics — read-only view of the raw registry. */
export function _allFragments(): readonly PromptFragment[] {
  return [...fragments];
}
