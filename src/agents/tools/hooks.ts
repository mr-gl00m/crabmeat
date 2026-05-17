import type { ValidatedInvocation, ToolResult } from "./types.js";
import type { Session } from "../../sessions/types.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";

export type PreHookVerdict =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "warn"; message: string };

export type PreHookFn = (
  invocation: ValidatedInvocation,
  session: Session,
) => Promise<PreHookVerdict> | PreHookVerdict;

export type PostHookFn = (
  invocation: ValidatedInvocation,
  result: ToolResult,
  session: Session,
) => Promise<ToolResult> | ToolResult;

export interface ToolHookRunner {
  registerPreHook(name: string, hook: PreHookFn): void;
  registerPostHook(name: string, hook: PostHookFn): void;
  removePreHook(name: string): void;
  removePostHook(name: string): void;
  runPreHooks(
    invocation: ValidatedInvocation,
    session: Session,
  ): Promise<PreHookVerdict>;
  runPostHooks(
    invocation: ValidatedInvocation,
    result: ToolResult,
    session: Session,
  ): Promise<ToolResult>;
  readonly preHookCount: number;
  readonly postHookCount: number;
}

export function createToolHookRunner(): ToolHookRunner {
  const preHooks = new Map<string, PreHookFn>();
  const postHooks = new Map<string, PostHookFn>();

  return {
    get preHookCount() {
      return preHooks.size;
    },
    get postHookCount() {
      return postHooks.size;
    },

    registerPreHook(name, hook) {
      preHooks.set(name, hook);
    },
    registerPostHook(name, hook) {
      postHooks.set(name, hook);
    },
    removePreHook(name) {
      preHooks.delete(name);
    },
    removePostHook(name) {
      postHooks.delete(name);
    },

    async runPreHooks(invocation, session) {
      for (const [name, hook] of preHooks) {
        try {
          const verdict = await hook(invocation, session);
          if (verdict.action === "deny") {
            logger.warn(
              {
                hook: name,
                toolId: invocation.toolId,
                reason: verdict.reason,
              },
              "Pre-hook denied tool execution",
            );
            return verdict;
          }
          if (verdict.action === "warn") {
            logger.warn(
              {
                hook: name,
                toolId: invocation.toolId,
                message: verdict.message,
              },
              "Pre-hook warning",
            );
          }
        } catch (err) {
          logger.error(
            {
              hook: name,
              error: formatErrorMessage(err),
            },
            "Pre-hook threw — denying execution for safety",
          );
          return {
            action: "deny" as const,
            reason: `Pre-hook '${name}' failed`,
          };
        }
      }
      return { action: "allow" as const };
    },

    async runPostHooks(invocation, result, session) {
      let current = result;
      for (const [name, hook] of postHooks) {
        try {
          current = await hook(invocation, current, session);
        } catch (err) {
          logger.error(
            {
              hook: name,
              error: formatErrorMessage(err),
            },
            "Post-hook threw — passing result through unchanged",
          );
        }
      }
      return current;
    },
  };
}
