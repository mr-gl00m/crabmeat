import type { z } from "zod";

export type EffectClass = "read" | "write" | "network" | "exec" | "privileged";

export const EFFECT_CLASSES: readonly EffectClass[] = [
  "read",
  "write",
  "network",
  "exec",
  "privileged",
] as const;

export const HIGH_IMPACT_EFFECTS: ReadonlySet<EffectClass> = new Set([
  "write",
  "network",
  "exec",
  "privileged",
]);

export interface ToolParameterDef {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required: boolean;
  enum?: ReadonlyArray<string | number>;
  default?: unknown;
  secretRef: boolean;
}

/**
 * Structured output schema for a tool. Runtime metadata only —
 * NOT exposed to the LLM in tool declarations. Used by Phase 2
 * DAG validator to type-check `s2.inputs.foo = s1.outputs.bar`
 * references, and by step-level memoization.
 */
export interface ToolOutputDef {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  /** When true, the field is always present in a successful result. */
  required: boolean;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, ToolParameterDef>;
  outputs: Record<string, ToolOutputDef>;
  effectClass: EffectClass;
  parameterSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * When true, the tool is gated to callers with role "owner". Set at
   * catalog construction time from src/security/owner-only-tools.ts.
   * Filtered out of LLM-facing declarations and rejected at validate
   * time for non-owner callers.
   */
  ownerOnly?: boolean;
}

/** Map of capability ID → tool ID. Computed per session. */
export type CapabilityMap = Map<string, string>;

/** What the LLM proposes (uses capability ID, not tool name). */
export interface ToolInvocation {
  capabilityId: string;
  callId: string;
  arguments: Record<string, unknown>;
}

/** What passes the validation gate. */
export interface ValidatedInvocation {
  toolId: string;
  toolName: string;
  callId: string;
  parameters: Record<string, unknown>;
  effectClass: EffectClass;
}

export interface ToolResult {
  toolId: string;
  callId: string;
  content: string;
  isError: boolean;
  /**
   * Structured outputs matching the tool's declared output schema.
   * Empty record for error cases or tools without declared outputs.
   * Consumed by the Phase 2 DAG executor for step-to-step data flow;
   * not serialized into the LLM context.
   */
  outputs: Record<string, unknown>;
}

/** Optional context passed to tool handlers for session-aware behavior. */
export interface ToolExecutionContext {
  sessionKey: string;
  agentId: string;
}

export type ToolExecuteHandler = (
  params: Record<string, unknown>,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
) => Promise<{
  content: string;
  isError?: boolean;
  /**
   * Optional structured outputs. Handlers SHOULD populate this for
   * every field declared in their `outputs` schema. Missing during
   * the migration is tolerated — invoke.ts defaults to {}.
   */
  outputs?: Record<string, unknown>;
}>;

/** LLM-facing tool declaration (uses cap ID as function name). */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
