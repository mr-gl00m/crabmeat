import { pathToFileURL } from "node:url";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type {
  HookHandlerFn,
  HookEvent,
  HookContext,
  HookResult,
} from "./types.js";
import type { FunctionHookHandlerConfig } from "./config.js";
import { formatErrorMessage } from "../infra/errors.js";

/**
 * Resolve and load a function hook handler once at startup. Caches the
 * imported handler for the lifetime of the process — there is no
 * reload-on-edit path in v0.
 *
 * The module path is resolved relative to the workspace root. Absolute
 * paths are accepted as-is. The handler must be either the default
 * export or the named export specified in `cfg.export`.
 */
export async function loadFunctionHook(
  cfg: FunctionHookHandlerConfig,
  workspaceRoot: string,
): Promise<HookHandlerFn> {
  const absPath = isAbsolute(cfg.module)
    ? cfg.module
    : resolvePath(workspaceRoot, cfg.module);
  const url = pathToFileURL(absPath).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    const msg = formatErrorMessage(err);
    throw new Error(
      `Failed to load function hook '${cfg.id}' from ${absPath}: ${msg}`,
    );
  }

  const exportName = cfg.export ?? "default";
  const candidate = mod[exportName];
  if (typeof candidate !== "function") {
    throw new Error(
      `Function hook '${cfg.id}' at ${absPath} does not export a function named '${exportName}'`,
    );
  }

  return candidate as HookHandlerFn;
}

/**
 * Run a function hook with a timeout. Never throws — any handler error
 * is converted into a `soft_error` HookResult. The caller is the
 * registry, which logs to the audit chain; this function does not
 * log directly.
 */
export async function runFunctionHook<E extends HookEvent>(
  hookId: string,
  fn: HookHandlerFn,
  ctx: HookContext<E>,
  timeoutMs: number,
): Promise<HookResult> {
  const ac = new AbortController();
  // Chain the outer signal so caller-driven cancellation propagates.
  if (ctx.signal.aborted) {
    return { outcome: "soft_error", error: "aborted before start" };
  }
  const onOuterAbort = () => ac.abort();
  ctx.signal.addEventListener("abort", onOuterAbort, { once: true });

  const innerCtx: HookContext<E> = { ...ctx, signal: ac.signal };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HookResult>((resolveTimeout) => {
    timer = setTimeout(() => {
      ac.abort();
      resolveTimeout({
        outcome: "soft_error",
        error: `hook '${hookId}' timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();
  });

  const execution: Promise<HookResult> = (async () => {
    try {
      const result = await Promise.resolve(fn(innerCtx));
      return result ?? { outcome: "ok" };
    } catch (err) {
      const msg = formatErrorMessage(err);
      return { outcome: "soft_error", error: msg };
    }
  })();

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onOuterAbort);
  }
}
