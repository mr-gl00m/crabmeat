import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  HOOK_EVENTS,
  BLOCKABLE_EVENTS,
  type HookEvent,
  type HookPayload,
  type HookContext,
  type RegisteredHook,
  type FireResult,
  type HookResult,
  type HookAuditSink,
  type HookOutcome,
} from "./types.js";
import type { HooksConfig, HookHandlerConfig } from "./config.js";
import { loadFunctionHook, runFunctionHook } from "./exec-function.js";
import { runCommandHook } from "./exec-command.js";

export interface LifecycleHookRegistry {
  /**
   * Fire an event to all registered handlers for it. Returns a FireResult
   * indicating whether a blocking event was blocked. Non-blockable events
   * always return `{ blocked: false }`. Never throws — handler errors are
   * caught and routed to the audit sink as `soft_error` outcomes.
   */
  fire<E extends HookEvent>(event: E, payload: HookPayload<E>): Promise<FireResult>;

  /** Number of handlers registered for a given event (for tests + /status). */
  handlerCount(event: HookEvent): number;

  /** True iff `disableAll` is set in config. */
  readonly disableAll: boolean;
}

export interface CreateRegistryOptions {
  config: HooksConfig;
  workspaceRoot: string;
  audit?: HookAuditSink;
}

const EMPTY_REGISTRY: LifecycleHookRegistry = {
  async fire() {
    return { blocked: false };
  },
  handlerCount() {
    return 0;
  },
  disableAll: true,
};

/**
 * Build a lifecycle hook registry from a validated HooksConfig. Function
 * handlers are resolved and loaded eagerly at startup so a malformed hook
 * surfaces at boot, not at the first turn. Command handlers are resolved
 * lazily (spawned on each fire) since there is nothing to load ahead of
 * time.
 *
 * If `disableAll` is set, a no-op registry is returned.
 */
export async function createLifecycleHookRegistry(
  opts: CreateRegistryOptions,
): Promise<LifecycleHookRegistry> {
  const { config, workspaceRoot, audit } = opts;

  if (config.disableAll) {
    logger.info("Lifecycle hooks: disableAll=true — no handlers will run");
    return EMPTY_REGISTRY;
  }

  const handlersByEvent: Map<HookEvent, RegisteredHook[]> = new Map();
  for (const event of HOOK_EVENTS) {
    handlersByEvent.set(event, []);
  }

  let loadedCount = 0;
  let failedCount = 0;

  for (const event of HOOK_EVENTS) {
    const list = config.handlers[event] ?? [];
    for (const raw of list) {
      const handler = await resolveHandler(raw, workspaceRoot);
      if (handler) {
        handlersByEvent.get(event)!.push({ ...handler, event });
        loadedCount++;
      } else {
        failedCount++;
      }
    }
  }

  logger.info(
    { loaded: loadedCount, failed: failedCount },
    "Lifecycle hooks: registry initialized",
  );

  return {
    disableAll: false,

    handlerCount(event) {
      return handlersByEvent.get(event)?.length ?? 0;
    },

    async fire(event, payload) {
      const handlers = handlersByEvent.get(event) ?? [];
      if (handlers.length === 0) {
        return { blocked: false };
      }

      const blockable = BLOCKABLE_EVENTS.has(event);

      for (const handler of handlers) {
        const startMs = Date.now();
        const ac = new AbortController();
        const ctx: HookContext = {
          event,
          payload: payload as HookPayload<HookEvent>,
          signal: ac.signal,
        };

        let result: HookResult;
        try {
          if (handler.kind === "function" && handler.fn) {
            result = await runFunctionHook(handler.id, handler.fn, ctx, handler.timeoutMs);
          } else if (handler.kind === "command" && handler.command) {
            result = await runCommandHook(
              handler.id,
              {
                type: "command",
                id: handler.id,
                run: handler.command,
                timeout: handler.timeoutMs,
              },
              ctx,
            );
          } else {
            result = { outcome: "soft_error", error: "malformed handler" };
          }
        } catch (err) {
          // Belt-and-suspenders: exec-function and exec-command already
          // convert exceptions to soft_error, but a bug in the registry
          // itself must not escape.
          const msg = formatErrorMessage(err);
          result = { outcome: "soft_error", error: msg };
        }

        const durationMs = Date.now() - startMs;
        const outcome = toOutcome(result);

        audit?.recordHookInvocation({
          sessionId: extractSessionId(payload),
          event,
          hookId: handler.id,
          kind: handler.kind,
          outcome,
          durationMs,
          errorSummary:
            result.outcome === "soft_error"
              ? result.error.slice(0, 200)
              : result.outcome === "blocked"
                ? result.reason.slice(0, 200)
                : undefined,
        });

        if (result.outcome === "soft_error") {
          logger.warn(
            { event, hookId: handler.id, error: result.error },
            "Lifecycle hook: soft error (continuing)",
          );
          continue;
        }

        if (result.outcome === "blocked") {
          if (blockable) {
            logger.info(
              { event, hookId: handler.id, reason: result.reason },
              "Lifecycle hook: blocked",
            );
            return {
              blocked: true,
              reason: result.reason,
              blockedByHookId: handler.id,
            };
          }
          // Blocked on a non-blockable event — coerce to soft_error
          // and record in the audit sink so the misuse is visible.
          logger.warn(
            { event, hookId: handler.id, reason: result.reason },
            "Lifecycle hook: returned 'blocked' on non-blockable event — coerced to soft_error",
          );
          audit?.recordHookInvocation({
            sessionId: extractSessionId(payload),
            event,
            hookId: handler.id,
            kind: handler.kind,
            outcome: "soft_error",
            durationMs: 0,
            errorSummary: `misuse: block on non-blockable event (${event})`,
          });
          continue;
        }
      }

      return { blocked: false };
    },
  };
}

/** Load a handler from its config form into a resolved RegisteredHook. */
async function resolveHandler(
  cfg: HookHandlerConfig,
  workspaceRoot: string,
): Promise<Omit<RegisteredHook, "event"> | undefined> {
  if (cfg.type === "function") {
    try {
      const fn = await loadFunctionHook(cfg, workspaceRoot);
      return {
        id: cfg.id,
        kind: "function",
        timeoutMs: cfg.timeout,
        fn,
      };
    } catch (err) {
      const msg = formatErrorMessage(err);
      logger.error({ hookId: cfg.id, error: msg }, "Failed to load function hook — skipping");
      return undefined;
    }
  }

  // command handler — nothing to preload
  return {
    id: cfg.id,
    kind: "command",
    timeoutMs: cfg.timeout,
    command: cfg.run,
  };
}

function toOutcome(r: HookResult): HookOutcome {
  if (r.outcome === "ok") return "ok";
  if (r.outcome === "blocked") return "blocked";
  return "soft_error";
}

/**
 * Every payload in HookPayloadMap carries a `sessionId`. Pulled via
 * type-narrowing on a structural check so we do not need a per-event
 * switch.
 */
function extractSessionId(payload: unknown): string {
  if (payload && typeof payload === "object" && "sessionId" in payload) {
    const v = (payload as { sessionId: unknown }).sessionId;
    if (typeof v === "string") return v;
  }
  return "unknown";
}
