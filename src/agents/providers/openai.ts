import OpenAI from "openai";
import type { ProviderConfig } from "../../config/types.js";
import type {
  Provider,
  ProviderRequest,
  StreamEvent,
  ToolCallRequest,
} from "./types.js";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0, // We handle retries via failover chain
    timeout: config.timeoutMs,
  });

  return {
    id: config.id,
    type: "openai",
    model: config.model,
    baseUrl: config.baseUrl,
    role: config.role,

    async stream(request: ProviderRequest, onEvent: (event: StreamEvent) => void) {
      let fullText = "";
      let promptTokens = 0;
      let completionTokens = 0;

      // Diagnostic counters. Surfaced via the `done` event when the turn
      // produces no visible content, so the inference layer can log a
      // useful "what did the provider actually send?" warning instead of
      // a generic "empty response". Drives the gpt-oss/Ollama silent-
      // analysis-channel investigation.
      let chunkCount = 0;
      let lastFinishReason: string | undefined;
      let reasoningText = ""; // delta.reasoning_content (DeepSeek, some gpt-oss/Ollama builds)
      let sawUnknownDeltaKeys = new Set<string>();
      // Set when finish_reason === "tool_calls" arrived but no tool call
      // deltas had ever been buffered. Provider-side bug condition —
      // there is nothing for us to call. The inference layer surfaces
      // this via the empty-response diagnostic hint.
      let toolCallsFinishWithoutDeltas = false;

      // Accumulate tool calls across stream deltas (hoisted so the
      // error handler can access partial tool call state for rescue).
      const pendingToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      try {
        // Build messages, mapping tool results to OpenAI's format
        const messages = request.messages.map((m) => {
          if (m.role === "tool" && m.toolCallId) {
            return {
              role: "tool" as const,
              tool_call_id: m.toolCallId,
              content: m.content,
            };
          }
          if (m.role === "assistant" && m.toolCalls?.length) {
            return {
              role: "assistant" as const,
              content: m.content || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            };
          }
          return { role: m.role as "system" | "user" | "assistant", content: m.content };
        });

        // Build tool declarations in OpenAI format
        const tools = request.tools?.length
          ? request.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined;

        // Provider-specific options forwarded as `extra_body` come FIRST,
        // explicit request fields LAST — so a config typo or hostile
        // providerOptions value cannot override model / messages /
        // max_tokens / tools. RT-2026-04-30-001.
        const stream = await client.chat.completions.create({
          ...(config.providerOptions
            ? ({ ...config.providerOptions } as Record<string, unknown>)
            : {}),
          model: request.model,
          messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools } : {}),
          ...(tools && request.toolChoice === "required"
            ? { tool_choice: "required" as const }
            : {}),
          // Forward reasoning_effort when configured. Gemini 2.5+ via
          // Google's OpenAI-compat layer reads this to control thinking
          // budget — without "none", 2.5 Flash burns the entire output
          // budget on internal reasoning and returns zero final-channel
          // content. Providers that don't recognize the param ignore it,
          // so this is safe to send on every request when configured.
          ...(config.reasoningEffort
            ? { reasoning_effort: config.reasoningEffort }
            : {}),
        });

        for await (const chunk of stream) {
          chunkCount++;
          const choice = chunk.choices[0];

          if (choice?.delta?.content) {
            fullText += choice.delta.content;
            onEvent({ type: "token", text: choice.delta.content });
          }

          // Capture reasoning content if the provider emits it. Not part
          // of the OpenAI SDK's typed delta surface, so we have to peek
          // at the raw object. DeepSeek uses `reasoning_content`, some
          // newer Ollama builds shipping gpt-oss expose `reasoning` or
          // `reasoning_content` for the harmony "analysis" channel. We
          // do NOT add this to fullText (the user does not want raw
          // chain-of-thought in their reply), but we count it so the
          // empty-response path can report "model emitted N reasoning
          // tokens, no final-channel content" instead of a misleading
          // "model produced nothing".
          if (choice?.delta) {
            const rawDelta = choice.delta as Record<string, unknown>;
            const r1 = rawDelta.reasoning_content;
            const r2 = rawDelta.reasoning;
            if (typeof r1 === "string" && r1.length > 0) reasoningText += r1;
            if (typeof r2 === "string" && r2.length > 0) reasoningText += r2;
            // Record any delta keys we don't recognize — useful for
            // diagnosing new providers that route content through novel
            // fields (audio, images, hidden channels, etc.).
            for (const k of Object.keys(rawDelta)) {
              if (
                k !== "content" &&
                k !== "tool_calls" &&
                k !== "role" &&
                k !== "reasoning" &&
                k !== "reasoning_content" &&
                k !== "refusal"
              ) {
                sawUnknownDeltaKeys.add(k);
              }
            }
          }

          // Accumulate streamed tool call deltas. Some local providers
          // (Ollama, vLLM, certain LM Studio builds) split tool-call
          // metadata across multiple deltas instead of front-loading id
          // and name on the first one — capturing those fields only on
          // the initial delta dropped them when they arrived later, which
          // surfaced as empty tool names in the validation layer.
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const existing = pendingToolCalls.get(tc.index);
              if (existing) {
                if (tc.id && !existing.id) existing.id = tc.id;
                if (tc.function?.name && !existing.name) {
                  existing.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                pendingToolCalls.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }

          // Record the finish reason. Tool-call emission is deferred until
          // after the stream ends — see the unconditional flush below.
          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        // Flush accumulated tool calls once the stream ends, regardless of
        // finish_reason. Local backends — notably Ollama's OpenAI-compat
        // shim — routinely stream tool-call deltas but then report
        // finish_reason "stop" rather than "tool_calls"; gating emission on
        // "tool_calls" silently dropped them. Flushing unconditionally
        // once the stream ends avoids that.
        if (pendingToolCalls.size > 0) {
          const toolCalls: ToolCallRequest[] = [];
          for (const [, tc] of [...pendingToolCalls.entries()].sort(
            (a, b) => a[0] - b[0],
          )) {
            toolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
          onEvent({ type: "tool_call", toolCalls });
          pendingToolCalls.clear();
        } else if (lastFinishReason === "tool_calls") {
          // finish_reason said tool_calls but nothing was ever buffered.
          toolCallsFinishWithoutDeltas = true;
        }

        onEvent({
          type: "done",
          fullText,
          usage: { promptTokens, completionTokens },
          model: config.model,
          diagnostics: {
            chunkCount,
            finishReason: lastFinishReason,
            reasoningChars: reasoningText.length,
            reasoningPreview:
              reasoningText.length > 0 ? reasoningText.slice(0, 200) : undefined,
            unknownDeltaKeys:
              sawUnknownDeltaKeys.size > 0 ? [...sawUnknownDeltaKeys] : undefined,
            droppedToolCallDeltas: pendingToolCalls.size,
            toolCallsFinishWithoutDeltas,
          },
        });
      } catch (err) {
        // Ollama (and some local providers) validate tool call argument JSON
        // server-side. If the model dumps chain-of-thought into the arguments,
        // the server returns a 500 before CrabMeat ever sees the tool call.
        // We extract the JSON from the error and emit it as a normal tool_call.
        const rescued = rescueOllamaToolCallError(err, pendingToolCalls, request.tools);
        if (rescued) {
          onEvent({ type: "tool_call", toolCalls: rescued });
          onEvent({
            type: "done",
            fullText,
            usage: { promptTokens, completionTokens },
          });
          return;
        }

        const error = err instanceof Error ? err : new Error(String(err));
        const { retryable, cascadable } = classifyOpenAIError(err);
        onEvent({ type: "error", error, retryable, cascadable });
      }
    },
  };
}

/**
 * When Ollama returns a 500 because the model put chain-of-thought in
 * the tool call arguments, the error message contains the raw text:
 *   "500 error parsing tool call: raw='<reasoning>{"key":"val"}'"
 * We extract the JSON object and build a synthetic tool call array.
 */
function rescueOllamaToolCallError(
  err: unknown,
  pendingToolCalls: Map<number, { id: string; name: string; arguments: string }>,
  tools?: ProviderRequest["tools"],
): ToolCallRequest[] | null {
  if (!(err instanceof OpenAI.APIError) || err.status !== 500) return null;

  const msg = err.message ?? "";
  if (!msg.includes("error parsing tool call")) return null;

  // Search the entire error message for a JSON object.
  const jsonStr = extractJsonObject(msg);
  if (!jsonStr) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  const id = `call_rescued_${Date.now()}`;
  let name = "";

  // 1. Try pending tool call deltas (Ollama may have streamed the name first)
  if (pendingToolCalls.size > 0) {
    const first = [...pendingToolCalls.values()][0]!;
    name = first.name;
  }

  // 2. Match JSON keys against tool parameter schemas
  if (!name && tools?.length) {
    const argKeys = new Set(Object.keys(parsed));
    let bestMatch = "";
    let bestScore = 0;

    for (const tool of tools) {
      const props = (tool.parameters as Record<string, unknown>)?.properties;
      const paramKeys = Object.keys((props as Record<string, unknown>) ?? {});
      if (paramKeys.length === 0) continue;

      // Score = how many of the JSON keys match this tool's parameters
      const hits = paramKeys.filter((k) => argKeys.has(k)).length;
      if (hits > bestScore) {
        bestScore = hits;
        bestMatch = tool.name;
      }
    }

    if (bestMatch && bestScore > 0) {
      name = bestMatch;
    }
  }

  if (!name) return null;

  return [{ id, name, arguments: jsonStr }];
}

/** Extract the first balanced JSON object from a string. */
function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }

  return null;
}

/**
 * Classify an OpenAI-shaped error for the failover cascade.
 *
 *   retryable  → advance the chain *with* a cooldown on this provider
 *                (transport flakes: 429, 5xx, ECONNREFUSED).
 *   cascadable → advance the chain *without* a cooldown. The provider
 *                is up — the request shape (model name, params, auth)
 *                is wrong, so bricking the whole provider for 30s
 *                would just delay the same request next turn for no
 *                reason.
 *
 * Status mapping:
 *   400 → cascadable. Catches "model not found" / bad params / etc.
 *         Google's OpenAI-compat layer returns 400 (not 404) for
 *         unknown models and often with no parseable body, so
 *         message-pattern matching is unreliable. Cost of a wrong
 *         cascade is "next provider also rejects" which surfaces
 *         the real CrabMeat-side bug anyway; cost of NOT cascading
 *         is a 30s cooldown that masks every config flip.
 *   401/403 → permanent (auth fix needed, retry won't help).
 *   404 → cascadable (model name wrong).
 *   429 → retryable (rate limit, cool down briefly then advance).
 *   5xx → retryable (server-side flake).
 *   ECONNREFUSED → retryable (provider daemon down).
 *
 * Anything that's neither retryable nor cascadable falls through to
 * the model-level pattern matching in model-select.ts (which itself
 * keeps the provider available — see MODEL_LEVEL_ERROR_PATTERNS).
 */
function classifyOpenAIError(err: unknown): { retryable: boolean; cascadable: boolean } {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 400 || err.status === 404) {
      return { retryable: false, cascadable: true };
    }
    if (err.status === 429) return { retryable: true, cascadable: false };
    if (err.status !== undefined && err.status >= 500) {
      return { retryable: true, cascadable: false };
    }
    return { retryable: false, cascadable: false };
  }
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) {
    return { retryable: true, cascadable: false };
  }
  return { retryable: false, cascadable: false };
}
