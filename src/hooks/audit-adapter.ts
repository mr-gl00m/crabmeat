import { randomUUID } from "node:crypto";
import type { AuditLog } from "../security/audit.js";
import type { HookAuditSink } from "./types.js";

/**
 * Wrap the existing tool-call AuditLog so lifecycle hook invocations
 * appear in the same SHA-256 chain as tool calls. Uses the pseudo-tool
 * shim: effectClass="hook", toolId="hook:<id>", toolName="<event>:<id>".
 *
 * This keeps the audit log single-source (no parallel chain) and gives
 * Receipts-by-default a uniform stream to read.
 */
export function adaptAuditLogAsHookSink(auditLog: AuditLog): HookAuditSink {
  return {
    recordHookInvocation(entry) {
      const resultStatus =
        entry.outcome === "ok"
          ? "success"
          : entry.outcome === "blocked"
            ? "denied"
            : "error";

      auditLog.record({
        timestamp: new Date().toISOString(),
        sessionKey: entry.sessionId,
        toolId: `hook:${entry.hookId}`,
        toolName: `${entry.event}:${entry.hookId}`,
        effectClass: "hook",
        callId: randomUUID(),
        parameters: {
          event: entry.event,
          kind: entry.kind,
          ...(entry.errorSummary ? { errorSummary: entry.errorSummary } : {}),
        },
        resultStatus,
        durationMs: entry.durationMs,
      });
    },
  };
}
