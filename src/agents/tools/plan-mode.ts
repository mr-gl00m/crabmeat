/**
 * plan_mode — Phase 1: Claude-Code-style gated planning checkpoint.
 *
 * Semantics:
 *   - enter : flip the session into plan mode. While active, the runtime
 *             denies all write/exec/network/privileged tool calls. The
 *             agent can still read, grep, search, think, etc.
 *   - exit  : submit a structured plan and flip plan mode off. The plan
 *             is surfaced to the user as tool content for approval, and
 *             stashed per-session so Phase 2's DAG compiler can pick it
 *             up without the agent having to re-describe it.
 *   - status: query the current state (active? has last plan?).
 *
 * The plan schema is the "LLM-as-compiler-frontend" contract — the same
 * shape Phase 2's DAG executor will consume verbatim. We validate
 * structure (required fields, types) but not semantic correctness
 * (tool ids, output refs) — that's Phase 2's job.
 *
 * Plan mode is tracked in a per-session Map rather than on the Session
 * type itself so the gating check is a pure module-level lookup and
 * does not require threading a Session object through validate.ts.
 */

import { registerToolHandler } from "./handlers.js";
import type { ToolExecutionContext, EffectClass } from "./types.js";
import { logger } from "../../infra/logger.js";

type BuiltinResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

export const MAX_PLAN_GOAL_LEN = 500;
export const MAX_PLAN_STEPS = 30;
export const MAX_STEP_ID_LEN = 48;
export const MAX_STEP_TOOL_LEN = 48;

export interface PlanStep {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  /** Declared output ids this step produces (free-form for P1). */
  outputs?: string[];
  /** Ids of other steps this one depends on. */
  depends_on?: string[];
  /** Agent-visible tier label (e.g. "read", "verify", "write"). */
  tier?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** 0-1 confidence the plan will succeed without replan. */
  confidence: number;
}

interface PlanState {
  active: boolean;
  lastPlan?: Plan;
  /** Wall-clock of last state change for logging / timeout hygiene. */
  updatedAt: number;
}

const state: Map<string, PlanState> = new Map();

// ── Effect classes blocked while plan mode is active ─────────
// "read" and "privileged" are NOT in this set by design:
//   - read: planning needs to look at files/search/grep, that's the point.
//   - privileged: kept on the usual deny-path (effect class is user-config
//     gated); plan mode doesn't need to double-block it.
// "write", "exec", "network" are blocked — this is the CC-style
// "read-only until you show me a plan" contract.
const BLOCKED_IN_PLAN_MODE: ReadonlySet<EffectClass> = new Set([
  "write",
  "exec",
  "network",
]);

export function isEffectBlockedByPlanMode(
  sessionKey: string,
  effect: EffectClass,
): boolean {
  const s = state.get(sessionKey);
  if (!s?.active) return false;
  return BLOCKED_IN_PLAN_MODE.has(effect);
}

export function isPlanModeActive(sessionKey: string): boolean {
  return state.get(sessionKey)?.active === true;
}

export function getLastPlan(sessionKey: string): Plan | undefined {
  return state.get(sessionKey)?.lastPlan;
}

/** For tests only. */
export function _resetPlanModeState(): void {
  state.clear();
}

// ── Plan validation ──────────────────────────────────────────

function validatePlan(raw: unknown): { plan?: Plan; error?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "'plan' must be an object with {goal, steps, confidence}." };
  }
  const p = raw as Record<string, unknown>;

  const goal = typeof p.goal === "string" ? p.goal.trim() : "";
  if (!goal) {
    return { error: "plan.goal is required and must be a non-empty string." };
  }
  if (goal.length > MAX_PLAN_GOAL_LEN) {
    return {
      error: `plan.goal too long (${goal.length} > ${MAX_PLAN_GOAL_LEN}).`,
    };
  }

  if (!Array.isArray(p.steps)) {
    return { error: "plan.steps must be an array." };
  }
  if (p.steps.length === 0) {
    return { error: "plan.steps must contain at least one step." };
  }
  if (p.steps.length > MAX_PLAN_STEPS) {
    return {
      error: `plan.steps too many (${p.steps.length} > ${MAX_PLAN_STEPS}).`,
    };
  }

  const steps: PlanStep[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < p.steps.length; i++) {
    const raw = p.steps[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `step ${i}: must be an object.` };
    }
    const s = raw as Record<string, unknown>;

    const id = typeof s.id === "string" ? s.id.trim().slice(0, MAX_STEP_ID_LEN) : "";
    if (!id) return { error: `step ${i}: 'id' is required.` };
    if (seenIds.has(id)) return { error: `step ${i}: duplicate id '${id}'.` };
    seenIds.add(id);

    const tool = typeof s.tool === "string" ? s.tool.trim().slice(0, MAX_STEP_TOOL_LEN) : "";
    if (!tool) return { error: `step ${i}: 'tool' is required.` };

    let inputs: Record<string, unknown> = {};
    if (s.inputs !== undefined) {
      if (typeof s.inputs !== "object" || s.inputs === null || Array.isArray(s.inputs)) {
        return { error: `step ${i}: 'inputs' must be an object.` };
      }
      inputs = s.inputs as Record<string, unknown>;
    }

    const step: PlanStep = { id, tool, inputs };

    if (s.outputs !== undefined) {
      if (!Array.isArray(s.outputs) || s.outputs.some((v) => typeof v !== "string")) {
        return { error: `step ${i}: 'outputs' must be an array of strings.` };
      }
      step.outputs = s.outputs as string[];
    }

    if (s.depends_on !== undefined) {
      if (!Array.isArray(s.depends_on) || s.depends_on.some((v) => typeof v !== "string")) {
        return { error: `step ${i}: 'depends_on' must be an array of strings.` };
      }
      const deps = s.depends_on as string[];
      for (const dep of deps) {
        if (!seenIds.has(dep) && dep !== id) {
          return {
            error: `step ${i}: depends_on references unknown step '${dep}' (forward refs not allowed).`,
          };
        }
      }
      step.depends_on = deps;
    }

    if (s.tier !== undefined) {
      if (typeof s.tier !== "string") {
        return { error: `step ${i}: 'tier' must be a string.` };
      }
      step.tier = s.tier;
    }

    steps.push(step);
  }

  let confidence = 0.5;
  if (p.confidence !== undefined) {
    if (typeof p.confidence !== "number" || !Number.isFinite(p.confidence)) {
      return { error: "plan.confidence must be a finite number between 0 and 1." };
    }
    if (p.confidence < 0 || p.confidence > 1) {
      return { error: "plan.confidence must be between 0 and 1." };
    }
    confidence = p.confidence;
  }

  return { plan: { goal, steps, confidence } };
}

function formatPlanForUser(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Goal: ${plan.goal}`);
  lines.push(`Confidence: ${(plan.confidence * 100).toFixed(0)}%`);
  lines.push(`Steps (${plan.steps.length}):`);
  for (const s of plan.steps) {
    const deps = s.depends_on?.length ? ` ← [${s.depends_on.join(", ")}]` : "";
    const tier = s.tier ? ` [${s.tier}]` : "";
    lines.push(`  ${s.id}: ${s.tool}${tier}${deps}`);
  }
  return lines.join("\n");
}

// ── Tool handler ─────────────────────────────────────────────

async function handlePlanMode(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<BuiltinResult> {
  if (!context?.sessionKey) {
    return {
      content: "plan_mode is only available inside an active user session.",
      isError: true,
    };
  }
  const sessionKey = context.sessionKey;
  const action = typeof params.action === "string" ? params.action : "";

  switch (action) {
    case "enter": {
      state.set(sessionKey, { active: true, updatedAt: Date.now() });
      logger.info({ sessionKey }, "plan_mode entered");
      return {
        content:
          "plan_mode: ENTERED. Write / exec / network tools are now denied. " +
          "Use read-only tools (file_read, grep_search, glob_search, file_list, memory_read, web_fetch) " +
          "to investigate, then call plan_mode(action=\"exit\", plan={...}) with a structured plan.",
        outputs: { action: "enter", active: true },
      };
    }

    case "exit": {
      const current = state.get(sessionKey);
      if (!current?.active) {
        return {
          content: "plan_mode: not currently active — nothing to exit.",
          isError: true,
        };
      }
      if (params.plan === undefined) {
        return {
          content:
            "plan_mode: exit requires a 'plan' argument with {goal, steps[], confidence}.",
          isError: true,
        };
      }
      const { plan, error } = validatePlan(params.plan);
      if (error) {
        return { content: `plan_mode: ${error}`, isError: true };
      }
      state.set(sessionKey, {
        active: false,
        lastPlan: plan,
        updatedAt: Date.now(),
      });
      logger.info(
        { sessionKey, goal: plan!.goal, steps: plan!.steps.length },
        "plan_mode exited with plan",
      );
      const formatted = formatPlanForUser(plan!);
      return {
        content:
          "plan_mode: EXITED. Write / exec / network tools are re-enabled.\n\n" +
          "Proposed plan:\n" +
          formatted +
          "\n\n(User: approve to execute, or say what to change.)",
        outputs: { action: "exit", active: false, plan },
      };
    }

    case "status": {
      const s = state.get(sessionKey);
      const active = s?.active === true;
      const hasLastPlan = s?.lastPlan !== undefined;
      const content = active
        ? "plan_mode: ACTIVE. Write/exec/network denied. Exit with a structured plan."
        : hasLastPlan
          ? "plan_mode: inactive. Last plan is cached (exit output available)."
          : "plan_mode: inactive. No plan cached.";
      return {
        content,
        outputs: {
          action: "status",
          active,
          has_last_plan: hasLastPlan,
          last_plan: s?.lastPlan ?? null,
        },
      };
    }

    case "":
      return {
        content: "plan_mode: 'action' is required. Use: enter, exit, status.",
        isError: true,
      };

    default:
      return {
        content: `plan_mode: unknown action '${action}'. Use: enter, exit, status.`,
        isError: true,
      };
  }
}

export function registerPlanModeTool(): void {
  registerToolHandler("plan_mode", handlePlanMode);
  logger.info({ tools: ["plan_mode"] }, "plan_mode tool registered");
}

export { handlePlanMode as _handlePlanMode, validatePlan as _validatePlan };
