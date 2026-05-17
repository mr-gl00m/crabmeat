export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A block of system prompt content. Providers that support prompt
 * caching (Anthropic) use the `cacheControl` hint to avoid
 * re-sending stable content every turn.
 */
export interface SystemPromptBlock {
  text: string;
  cacheControl?: "ephemeral";
}

export interface ProviderRequest {
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  tools?: ToolDeclaration[];
  /** Structured system prompt blocks for cache-aware providers. */
  systemBlocks?: SystemPromptBlock[];
  /**
   * Force a tool call on this iteration. "auto" lets the model decide;
   * "required" makes the model emit a tool call before any text. Used by
   * the inference layer to break local models out of "answer from
   * memory" mode on time-sensitive queries (news, headlines, current
   * events) where confabulation is the failure mode.
   */
  toolChoice?: "auto" | "required";
}

export interface StreamToken {
  type: "token";
  text: string;
}

/**
 * Optional per-stream diagnostics surfaced on the `done` event. Used by
 * the inference layer to write a useful log line when a stream ends with
 * no visible content — e.g. "model emitted 18 reasoning tokens, no
 * final-channel content" instead of a generic "produced nothing".
 *
 * Fields are best-effort: providers fill in what they know.
 */
export interface StreamDoneDiagnostics {
  /** Total chunks observed on the stream. */
  chunkCount?: number;
  /** Last finish_reason the provider emitted (stop, length, tool_calls, ...). */
  finishReason?: string;
  /**
   * Total chars the provider emitted into reasoning_content / reasoning
   * delta fields (chain-of-thought channels not surfaced as visible text).
   */
  reasoningChars?: number;
  /** First ~200 chars of any captured reasoning content, for log diagnostics. */
  reasoningPreview?: string;
  /**
   * Names of any delta keys observed that the provider implementation
   * doesn't recognize. Hint that a future provider is routing content
   * through a novel field we should learn to read.
   */
  unknownDeltaKeys?: string[];
  /**
   * Number of partial tool call deltas the provider buffered but never
   * emitted (typically because finish_reason was not "tool_calls"). A
   * non-zero value is a latent bug indicator.
   */
  droppedToolCallDeltas?: number;
  /**
   * True if the provider emitted finish_reason="tool_calls" but never
   * produced any tool call deltas to accumulate. A provider-side bug —
   * we have nothing to invoke. Surfaced via the empty-response hint.
   */
  toolCallsFinishWithoutDeltas?: boolean;
}

export interface StreamDone {
  type: "done";
  fullText: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /**
     * Prompt-cache token counts, surfaced by providers that support
     * caching (Anthropic today, OpenAI partial). Optional because
     * most providers don't report them. The cost tracker treats
     * missing fields as 0.
     */
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  /**
   * The model that actually served this stream. Reflects the provider's
   * configured model, not the request's "requested model." Lets the
   * cost tracker price the right model when the cascade routes a turn
   * to a fallback (e.g. Gemini cascaded to Ollama → cost should track
   * gpt-oss:latest, not gemini-2.5-flash).
   */
  model?: string;
  diagnostics?: StreamDoneDiagnostics;
}

export interface StreamError {
  type: "error";
  error: Error;
  retryable: boolean;
  /**
   * When true, the failover cascade should advance to the next provider
   * immediately *without* putting this provider in cooldown. Used for
   * configuration-shaped failures (model not found / 404) that don't
   * indicate the provider is down — just that the requested model name
   * is wrong. Bricking the provider for 30s on a 404 wastes the rest of
   * the turn waiting for cooldown to lift on the next request. Distinct
   * from `retryable` (which advances *with* cooldown) and from
   * model-level errors (which propagate without advancing at all).
   */
  cascadable?: boolean;
}

export interface StreamToolCall {
  type: "tool_call";
  toolCalls: ToolCallRequest[];
}

export type StreamEvent = StreamToken | StreamDone | StreamError | StreamToolCall;

/**
 * A provider implements streaming inference against a specific AI API.
 * The stream callback fires for each token, then once for done/error.
 *
 * Beyond `id` and `type`, each provider self-describes its configured
 * model/baseUrl/role so the selector layer can do priority-mode sorts
 * and emit useful fallback diagnostics without taking a parallel
 * config array. These three fields are read-only mirrors of the
 * provider's ProviderConfig — never sent on the wire, never mutated.
 */
export interface Provider {
  readonly id: string;
  readonly type: "openai" | "anthropic" | "ollama";
  /** Configured model name (e.g. "gemini-2.5-flash", "gpt-oss:latest"). */
  readonly model: string;
  /** Configured baseUrl, when set. Used by the selector's loopback heuristic for api-first / local-first sorting. */
  readonly baseUrl?: string;
  /** Optional semantic role tag from ProviderConfig.role. */
  readonly role?: "primary" | "backup" | "uncensored";

  stream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<void>;
}
