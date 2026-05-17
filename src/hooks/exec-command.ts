import { spawn } from "node:child_process";
import type {
  HookEvent,
  HookContext,
  HookResult,
} from "./types.js";
import type { CommandHookHandlerConfig } from "./config.js";
import { formatErrorMessage } from "../infra/errors.js";

/**
 * Run a command hook. The handler is a shell command; the hook context
 * (event + payload) is piped to stdin as a single JSON object; the
 * command is expected to emit one JSON object on stdout with shape
 *   { outcome: "ok" | "blocked" | "soft_error", reason?, error? }
 * OR exit cleanly with empty stdout (treated as "ok"). Any parse
 * failure, non-zero exit, or timeout converts to `soft_error`.
 *
 * Never throws.
 */
export async function runCommandHook<E extends HookEvent>(
  hookId: string,
  cfg: CommandHookHandlerConfig,
  ctx: HookContext<E>,
): Promise<HookResult> {
  if (ctx.signal.aborted) {
    return { outcome: "soft_error", error: "aborted before start" };
  }

  const payload = JSON.stringify({
    event: ctx.event,
    payload: ctx.payload,
  });

  return new Promise<HookResult>((resolve) => {
    let child;
    try {
      // shell:true lets users write natural commands (e.g. "./hook.sh")
      // without caring about argv splitting. They already get shell-
      // level sandboxing concerns via the workspace discipline, and
      // command hooks are opt-in via config.
      child = spawn(cfg.run, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = formatErrorMessage(err);
      resolve({ outcome: "soft_error", error: `spawn failed: ${msg}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: HookResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      settle({
        outcome: "soft_error",
        error: `hook '${hookId}' timed out after ${cfg.timeout}ms`,
      });
    }, cfg.timeout);
    timer.unref?.();

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      settle({ outcome: "soft_error", error: "aborted" });
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      settle({
        outcome: "soft_error",
        error: `child error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);

      if (code !== 0) {
        settle({
          outcome: "soft_error",
          error: `exit ${code}${stderr ? ": " + stderr.trim().slice(0, 200) : ""}`,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        settle({ outcome: "ok" });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as {
          outcome?: string;
          reason?: string;
          error?: string;
        };
        if (parsed.outcome === "blocked") {
          settle({
            outcome: "blocked",
            reason: typeof parsed.reason === "string" ? parsed.reason : "blocked by hook",
          });
        } else if (parsed.outcome === "soft_error") {
          settle({
            outcome: "soft_error",
            error: typeof parsed.error === "string" ? parsed.error : "hook reported soft_error",
          });
        } else {
          settle({ outcome: "ok" });
        }
      } catch {
        settle({
          outcome: "soft_error",
          error: "hook stdout was not valid JSON",
        });
      }
    });

    // Write the payload and close stdin so the child can proceed.
    try {
      child.stdin?.write(payload, (err) => {
        if (err) {
          // Non-fatal — some hooks may not read stdin. Still try to close.
        }
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
      });
    } catch {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
    }
  });
}
