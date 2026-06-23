/**
 * subagent_spawn — budgeted child inference for parallelizable subtasks.
 *
 * The parent agent delegates a self-contained task to a fresh child
 * context. The child runs the same agent config but with:
 *
 *   1. Scoped context — only the task prompt, NOT the parent's transcript.
 *      This is the main payoff: subagents protect the parent from noisy
 *      intermediate tool output (ripgrep dumps, page scrapes, etc).
 *   2. Hard budgets — turn cap, wall-clock cap, and the child inherits
 *      the agent's normal rate limits. Any breach returns partial text
 *      with `timed_out: true`.
 *   3. Depth guard — the child's tool set excludes subagent_spawn, so
 *      a child cannot recursively spawn grandchildren. Strictly depth=1.
 *   4. Inherited audit chain — every child tool call is recorded to the
 *      same audit log under the parent's session key, so there is no
 *      "off-the-books" execution.
 *   5. Synchronous return — the parent is blocked until the child
 *      finishes (or budgets trip). No fire-and-forget.
 *
 * The actual child loop lives in inference.ts (where the provider,
 * catalog, selector, and hook runner all live). This file is a thin
 * shell that validates args, enforces caps, and calls into the runtime
 * injected at pipeline construction time.
 */

import { registerToolHandler } from "./handlers.js";
import type { ToolExecutionContext } from "./types.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";

type BuiltinResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

export const MAX_TASK_LEN = 2_000;
export const MAX_CONTEXT_LEN = 4_000;
export const MAX_CHILD_TURNS = 5;
export const MAX_CHILD_WALL_CLOCK_MS = 60_000;
export const DEFAULT_CHILD_TURNS = 3;
export const DEFAULT_CHILD_WALL_CLOCK_MS = 30_000;

export interface SubagentRunRequest {
  task: string;
  /** Optional one-shot context the child receives alongside the task. */
  context?: string;
  /** Max inference turns (loop iterations). Capped at MAX_CHILD_TURNS. */
  maxTurns: number;
  /** Max wall-clock ms across all turns. Capped at MAX_CHILD_WALL_CLOCK_MS. */
  wallClockMs: number;
  /** Parent session key — audit entries inherit this. */
  parentSessionKey: string;
  /** Parent agent id — child inherits the same agent config. */
  parentAgentId: string;
}

export interface SubagentRunResult {
  text: string;
  turnsUsed: number;
  wallClockMs: number;
  timedOut: boolean;
  turnsExhausted: boolean;
  error?: string;
}

/**
 * Runtime injected by the inference pipeline once it has access to
 * the provider selector, catalog, hook runner, secret store, and
 * audit log. Kept as a setter so this module stays decoupled from
 * inference.ts (avoids circular imports).
 */
export type SubagentRuntime = (
  req: SubagentRunRequest,
) => Promise<SubagentRunResult>;

let runtime: SubagentRuntime | null = null;

export function setSubagentRuntime(r: SubagentRuntime | null): void {
  runtime = r;
}

export function _getSubagentRuntime(): SubagentRuntime | null {
  return runtime;
}

async function handleSubagentSpawn(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<BuiltinResult> {
  if (!context?.sessionKey || !context?.agentId) {
    return {
      content: "subagent_spawn is only available inside an active user session.",
      isError: true,
    };
  }

  if (!runtime) {
    return {
      content:
        "subagent_spawn: runtime not initialized (no inference pipeline bound).",
      isError: true,
    };
  }

  const task = typeof params.task === "string" ? params.task.trim() : "";
  if (!task) {
    return { content: "subagent_spawn: 'task' is required.", isError: true };
  }
  if (task.length > MAX_TASK_LEN) {
    return {
      content: `subagent_spawn: task too long (${task.length} > ${MAX_TASK_LEN}).`,
      isError: true,
    };
  }

  let childContext = "";
  if (params.context !== undefined) {
    if (typeof params.context !== "string") {
      return {
        content: "subagent_spawn: 'context' must be a string if provided.",
        isError: true,
      };
    }
    childContext = params.context.trim();
    if (childContext.length > MAX_CONTEXT_LEN) {
      return {
        content: `subagent_spawn: context too long (${childContext.length} > ${MAX_CONTEXT_LEN}).`,
        isError: true,
      };
    }
  }

  let maxTurns = DEFAULT_CHILD_TURNS;
  if (typeof params.max_turns === "number" && Number.isFinite(params.max_turns)) {
    maxTurns = Math.max(1, Math.min(MAX_CHILD_TURNS, Math.round(params.max_turns)));
  }

  let wallClockMs = DEFAULT_CHILD_WALL_CLOCK_MS;
  if (typeof params.wall_clock_ms === "number" && Number.isFinite(params.wall_clock_ms)) {
    wallClockMs = Math.max(
      1_000,
      Math.min(MAX_CHILD_WALL_CLOCK_MS, Math.round(params.wall_clock_ms)),
    );
  }

  logger.info(
    {
      parentSessionKey: context.sessionKey,
      parentAgentId: context.agentId,
      taskLen: task.length,
      maxTurns,
      wallClockMs,
    },
    "subagent_spawn starting child task",
  );

  const started = Date.now();
  try {
    const result = await runtime({
      task,
      context: childContext || undefined,
      maxTurns,
      wallClockMs,
      parentSessionKey: context.sessionKey,
      parentAgentId: context.agentId,
    });

    const lines: string[] = [];
    lines.push(
      `subagent_spawn: ${result.turnsUsed} turn(s), ${result.wallClockMs}ms` +
        (result.timedOut ? " — wall-clock exceeded" : "") +
        (result.turnsExhausted ? " — turn budget exhausted" : ""),
    );
    if (result.error) {
      lines.push(`error: ${result.error}`);
    }
    lines.push("", result.text || "(child produced no text)");

    const isError = Boolean(result.error) && !result.text;
    return {
      content: lines.join("\n"),
      isError,
      outputs: {
        text: result.text,
        turns_used: result.turnsUsed,
        wall_clock_ms: result.wallClockMs,
        timed_out: result.timedOut,
        turns_exhausted: result.turnsExhausted,
        error: result.error ?? "",
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    logger.warn(
      { err: msg, parentSessionKey: context.sessionKey },
      "subagent_spawn runtime threw",
    );
    return {
      content: `subagent_spawn failed: ${msg}`,
      isError: true,
      outputs: {
        text: "",
        turns_used: 0,
        wall_clock_ms: Date.now() - started,
        timed_out: false,
        turns_exhausted: false,
        error: msg,
      },
    };
  }
}

export function registerSubagentSpawnTool(): void {
  registerToolHandler("subagent_spawn", handleSubagentSpawn);
  logger.info({ tools: ["subagent_spawn"] }, "subagent_spawn tool registered");
}

export { handleSubagentSpawn as _handleSubagentSpawn };
