// Lifecycle hook system — the config-driven, user-facing hook spine.
//
// Distinct from src/agents/tools/hooks.ts (ToolHookRunner), which is a
// programmatic pre/post hook around individual tool invocations. This
// module covers broader lifecycle events and is loaded from config,
// not registered in code.

import type { Session } from "../sessions/types.js";
import type { ToolInvocation, ToolResult } from "../agents/tools/types.js";

export type HookEvent =
  | "session_start"
  | "session_resume"
  | "session_end"
  | "before_turn"
  | "after_turn"
  | "before_tool"
  | "after_tool"
  | "after_tool_failure"
  | "before_compact";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "session_start",
  "session_resume",
  "session_end",
  "before_turn",
  "after_turn",
  "before_tool",
  "after_tool",
  "after_tool_failure",
  "before_compact",
] as const;

export const BLOCKABLE_EVENTS: ReadonlySet<HookEvent> = new Set([
  "before_turn",
  "before_tool",
]);

// Per-event payload shapes. Keep these narrow — handlers should not
// rely on transcripts or raw provider responses.

export interface SessionStartPayload {
  sessionId: string;
  agentId: string;
  channelId?: string;
  peerId?: string;
}

export interface SessionResumePayload {
  sessionId: string;
  agentId: string;
  turnsSoFar: number;
  lastActivity: string;
}

export interface SessionEndPayload {
  sessionId: string;
  reason: "disconnect" | "timeout" | "shutdown" | "error" | "explicit";
}

export interface BeforeTurnPayload {
  sessionId: string;
  agentId: string;
  userMessage: string;
  turnIndex: number;
}

export interface AfterTurnPayload {
  sessionId: string;
  agentId: string;
  durationMs: number;
  iterations: number;
  toolsUsed: readonly string[];
  hadError: boolean;
}

export interface BeforeToolPayload {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolId: string;
  effectClass: string;
  callId: string;
  parameters: Record<string, unknown>;
}

export interface AfterToolPayload {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolId: string;
  effectClass: string;
  callId: string;
  durationMs: number;
  resultPreview?: string;
}

export interface AfterToolFailurePayload {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolId: string;
  effectClass: string;
  callId: string;
  durationMs: number;
  error: string;
}

export interface BeforeCompactPayload {
  sessionId: string;
  sizeBeforeTokens: number;
  transcriptEntries: number;
}

export interface HookPayloadMap {
  session_start: SessionStartPayload;
  session_resume: SessionResumePayload;
  session_end: SessionEndPayload;
  before_turn: BeforeTurnPayload;
  after_turn: AfterTurnPayload;
  before_tool: BeforeToolPayload;
  after_tool: AfterToolPayload;
  after_tool_failure: AfterToolFailurePayload;
  before_compact: BeforeCompactPayload;
}

export type HookPayload<E extends HookEvent> = HookPayloadMap[E];

export interface HookContext<E extends HookEvent = HookEvent> {
  event: E;
  payload: HookPayload<E>;
  signal: AbortSignal;
}

export type HookOutcome = "ok" | "blocked" | "soft_error";

export type HookResult =
  | { outcome: "ok" }
  | { outcome: "blocked"; reason: string }
  | { outcome: "soft_error"; error: string };

export type HookHandlerFn<E extends HookEvent = HookEvent> = (
  ctx: HookContext<E>,
) => HookResult | Promise<HookResult>;

export type HookHandlerKind = "function" | "command";

export interface RegisteredHook {
  id: string;
  event: HookEvent;
  kind: HookHandlerKind;
  timeoutMs: number;
  // For function hooks: resolved handler function.
  fn?: HookHandlerFn;
  // For command hooks: resolved shell invocation.
  command?: string;
}

export type FireResult =
  | { blocked: false }
  | { blocked: true; reason: string; blockedByHookId: string };

/**
 * Minimal surface the registry needs for audit integration. Decoupled
 * from the concrete AuditLog so tests can inject a fake and so the
 * registry does not drag in the full security module.
 */
export interface HookAuditSink {
  recordHookInvocation(entry: {
    sessionId: string;
    event: HookEvent;
    hookId: string;
    kind: HookHandlerKind;
    outcome: HookOutcome;
    durationMs: number;
    errorSummary?: string;
  }): void;
}

// These re-exports exist so downstream modules can use ToolInvocation /
// ToolResult shapes alongside the hook payloads without an extra import.
export type { Session, ToolInvocation, ToolResult };
