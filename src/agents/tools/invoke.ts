import { ToolExecutionError } from "../../infra/errors.js";
import { logger } from "../../infra/logger.js";
import { redactToolResultSecrets } from "../../security/sanitize.js";
import type { ValidatedInvocation, ToolResult, ToolExecuteHandler, ToolExecutionContext } from "./types.js";
import type { SecretStore } from "./secrets.js";
import { isSecretRef, parseSecretRef } from "./secrets.js";
import type { ToolHookRunner } from "./hooks.js";
import type { Session } from "../../sessions/types.js";
import { diagnostics } from "../../infra/diagnostics/index.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * Execute a validated tool invocation.
 *
 * - Resolves $SECRET:name references in parameters
 * - Wraps result in <TOOL_RESULT type="untrusted"> tag
 * - Enforces per-tool timeout
 * - Never throws — returns ToolResult with isError on failure
 */
export async function executeValidatedTool(
  validated: ValidatedInvocation,
  handler: ToolExecuteHandler,
  secretStore: SecretStore,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  hookRunner?: ToolHookRunner,
  session?: Session,
): Promise<ToolResult> {
  // Resolve secret references in parameters
  const resolvedParams = resolveSecrets(
    validated.parameters,
    secretStore,
    validated.toolId,
  );
  if (resolvedParams.error !== undefined) {
    return {
      toolId: validated.toolId,
      callId: validated.callId,
      content: resolvedParams.error,
      isError: true,
      outputs: {},
    };
  }

  const params = resolvedParams.params;

  // Run pre-hooks (can deny execution)
  if (hookRunner && session) {
    const verdict = await hookRunner.runPreHooks(validated, session);
    if (verdict.action === "deny") {
      return {
        toolId: validated.toolId,
        callId: validated.callId,
        content: wrapToolResult(validated.toolName, `Denied by hook: ${verdict.reason}`, true),
        isError: true,
        outputs: {},
      };
    }
  }

  // Build execution context from session if available
  const execContext: ToolExecutionContext | undefined = session
    ? { sessionKey: session.sessionKey, agentId: session.agentId }
    : undefined;

  const startedAt = Date.now();
  diagnostics.emit("tool.execution.started", {
    sessionKey: session?.sessionKey,
    toolName: validated.toolName,
    toolCallId: validated.callId,
  });

  try {
    // Execute with timeout + AbortController so timed-out handlers
    // can observe cancellation instead of running to completion as orphans.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let result: { content: string; isError?: boolean; outputs?: Record<string, unknown> };
    try {
      result = await Promise.race([
        handler(params, ac.signal, execContext),
        timeout(timeoutMs, validated.toolId),
      ]);
    } finally {
      clearTimeout(timer);
      // If handler completed before timeout, ensure signal is not left dangling
      if (!ac.signal.aborted) ac.abort();
    }

    // Scan tool result for secrets before it enters the context window
    const { redacted: safeContent, leaks } = redactToolResultSecrets(result.content);
    if (leaks.length > 0) {
      logger.warn(
        { toolId: validated.toolId, leaks: leaks.map((l) => l.label) },
        "Secrets detected in tool result — redacting before context entry",
      );
    }

    // Unified error logging: every tool error path goes through pino, so the
    // operator sees tool-layer failures even when the handler returned a
    // well-formed { isError: true } rather than throwing. Error message is
    // pre-redacted so log files never capture secrets.
    if (result.isError === true) {
      logger.warn(
        {
          toolId: validated.toolId,
          callId: validated.callId,
          errorCode: "tool_result_error",
          // First line of the message is usually the human summary —
          // keep it short and post-redaction.
          error: safeContent.split("\n")[0]?.slice(0, 400),
        },
        "Tool handler returned isError",
      );
    }

    // Structured outputs also need secret redaction on any string fields —
    // they're metadata, not LLM context, but they can still leak to disk
    // via audit logs or Phase 2 step-level memoization caches.
    const safeOutputs = redactOutputsDeep(result.outputs ?? {}, validated.toolId);

    const content = wrapToolResult(
      validated.toolName,
      safeContent,
      result.isError ?? false,
    );

    let toolResult: ToolResult = {
      toolId: validated.toolId,
      callId: validated.callId,
      content,
      isError: result.isError ?? false,
      outputs: safeOutputs,
    };

    // Run post-hooks (can annotate/modify result)
    if (hookRunner && session) {
      toolResult = await hookRunner.runPostHooks(validated, toolResult, session);
    }

    const durationMs = Date.now() - startedAt;
    if (toolResult.isError) {
      diagnostics.emit("tool.execution.error", {
        sessionKey: session?.sessionKey,
        toolName: validated.toolName,
        toolCallId: validated.callId,
        durationMs,
        errorCategory: "tool_result_error",
      });
    } else {
      diagnostics.emit("tool.execution.completed", {
        sessionKey: session?.sessionKey,
        toolName: validated.toolName,
        toolCallId: validated.callId,
        durationMs,
      });
    }

    return toolResult;
  } catch (err) {
    const rawMessage =
      err instanceof ToolExecutionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    // Error messages can contain connection strings, credentials, etc.
    const { redacted: safeMessage } = redactToolResultSecrets(rawMessage);

    logger.error(
      { toolId: validated.toolId, error: safeMessage },
      "Tool execution failed",
    );

    diagnostics.emit("tool.execution.error", {
      sessionKey: session?.sessionKey,
      toolName: validated.toolName,
      toolCallId: validated.callId,
      durationMs: Date.now() - startedAt,
      errorCategory:
        err instanceof ToolExecutionError
          ? "ToolExecutionError"
          : err instanceof Error && typeof err.name === "string" && err.name.trim()
            ? err.name
            : "unknown",
    });

    return {
      toolId: validated.toolId,
      callId: validated.callId,
      content: wrapToolResult(validated.toolName, safeMessage, true),
      isError: true,
      outputs: {},
    };
  }
}

/**
 * Recursively walk a structured outputs record and redact secrets
 * from every string leaf. Non-string values pass through unchanged.
 * Logs once per tool call if anything was redacted.
 */
function redactOutputsDeep(
  outputs: Record<string, unknown>,
  toolId: string,
): Record<string, unknown> {
  let anyLeak = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const { redacted, leaks } = redactToolResultSecrets(v);
      if (leaks.length > 0) anyLeak = true;
      return redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  const result = walk(outputs) as Record<string, unknown>;
  if (anyLeak) {
    logger.warn(
      { toolId },
      "Secrets detected in structured tool outputs — redacted before propagation",
    );
  }
  return result;
}

/**
 * Resolve $SECRET:name references in a parameter object.
 * Returns resolved params or an error message.
 */
function resolveSecrets(
  params: Record<string, unknown>,
  store: SecretStore,
  toolId: string,
): { params: Record<string, unknown>; error: undefined } | { params: undefined; error: string } {
  const resolved = { ...params };

  for (const [key, value] of Object.entries(resolved)) {
    if (isSecretRef(value)) {
      const secretName = parseSecretRef(value);
      if (!secretName) {
        return { params: undefined, error: `Invalid secret reference for parameter '${key}'` };
      }
      const secretValue = store.resolve(secretName);
      if (secretValue === undefined) {
        logger.warn(
          { toolId, parameter: key, secretName },
          "Secret reference not found",
        );
        return { params: undefined, error: `Secret '${secretName}' not found for parameter '${key}'` };
      }
      resolved[key] = secretValue;
    }
  }

  return { params: resolved, error: undefined };
}

/**
 * Wrap tool output in a trust boundary tag.
 * Includes a wall-clock timestamp so the LLM has an ambient
 * sense of real time passing between tool calls.
 */
function wrapToolResult(
  toolName: string,
  content: string,
  isError: boolean,
): string {
  const status = isError ? ' status="error"' : "";
  const clock = new Date().toISOString();
  return (
    `<TOOL_RESULT type="untrusted" tool="${toolName}"${status} timestamp="${clock}">\n` +
    content +
    "\n</TOOL_RESULT>"
  );
}

function timeout(ms: number, toolId: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new ToolExecutionError(toolId, `Tool '${toolId}' timed out after ${ms}ms`)),
      ms,
    ),
  );
}
