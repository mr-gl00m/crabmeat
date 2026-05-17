import type { ProviderConfig } from "../../config/types.js";
import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  StreamEvent,
  ToolCallRequest,
  ToolDeclaration,
} from "./types.js";

// Native Ollama provider. Talks to Ollama's own /api/chat endpoint rather
// than the OpenAI-compat /v1 shim that the "openai" provider type uses.
//
// The reason is num_ctx. Ollama's /v1/chat/completions endpoint silently
// drops the `options` object — a configured num_ctx never reaches the
// model, so a large agent system prompt gets truncated at the server
// default (~4096) and every local model produces broken output. The
// native /api/chat endpoint DOES read `options`, so the existing
// `providerOptions.options.num_ctx` config key actually takes effect here.
//
// Wire format: a POST whose response body is newline-delimited JSON. Each
// line is a chunk { message: { content?, thinking?, tool_calls? }, done }.
// The final line carries done:true plus prompt_eval_count / eval_count.

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Parse a tool-call argument string back into the object Ollama expects. */
function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    // Tool results: Ollama keys tool messages by name, not call id. The
    // call id we synthesized on the way out has no counterpart here, so
    // we just hand back role + content — Ollama pairs it positionally.
    if (m.role === "tool") {
      return { role: "tool", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: parseArgs(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOllamaTools(
  tools: ToolDeclaration[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Pull the Ollama `options` block out of providerOptions. We keep the
 * existing config shape — providerOptions.options.{num_ctx,num_predict,...}
 * — so a crabmeat.json written for the old "openai" type keeps working,
 * except now the keys are actually delivered to the model.
 */
function userOptions(config: ProviderConfig): Record<string, unknown> {
  const opts = config.providerOptions?.options;
  if (opts && typeof opts === "object" && !Array.isArray(opts)) {
    return opts as Record<string, unknown>;
  }
  return {};
}

/** Normalize a configured baseUrl to the bare Ollama host (no /v1, no slash). */
function ollamaBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl ?? "http://127.0.0.1:11434";
  return raw.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function classifyOllamaError(
  status: number | undefined,
  err: unknown,
): { retryable: boolean; cascadable: boolean } {
  if (status !== undefined) {
    // 404 → model not found / wrong name. Cascade without cooldown:
    // the daemon is up, the request shape is wrong.
    if (status === 404 || status === 400) {
      return { retryable: false, cascadable: true };
    }
    if (status === 429 || status >= 500) {
      return { retryable: true, cascadable: false };
    }
    return { retryable: false, cascadable: false };
  }
  // Transport failure — daemon down, or aborted on timeout.
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      err.name === "TimeoutError" ||
      err.name === "AbortError"
    ) {
      return { retryable: true, cascadable: false };
    }
  }
  return { retryable: false, cascadable: false };
}

export function createOllamaProvider(config: ProviderConfig): Provider {
  const endpoint = `${ollamaBaseUrl(config.baseUrl)}/api/chat`;

  return {
    id: config.id,
    type: "ollama",
    model: config.model,
    baseUrl: config.baseUrl,
    role: config.role,

    async stream(request: ProviderRequest, onEvent: (event: StreamEvent) => void) {
      let fullText = "";
      let reasoningText = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let chunkCount = 0;
      let doneReason: string | undefined;

      // Ollama emits tool calls complete (name + full arguments object) in
      // a single chunk rather than delta-streaming them, so we collect
      // them as they arrive and flush once the stream ends.
      const toolCalls: ToolCallRequest[] = [];

      // request.maxTokens caps generation via num_predict; an explicit
      // num_predict / temperature in providerOptions.options still wins.
      const options: Record<string, unknown> = {
        num_predict: request.maxTokens,
        temperature: request.temperature,
        ...userOptions(config),
      };

      const tools = toOllamaTools(request.tools);

      const body: Record<string, unknown> = {
        model: request.model,
        messages: toOllamaMessages(request.messages),
        stream: true,
        options,
        ...(tools ? { tools } : {}),
      };
      // Ollama's `think` toggles the reasoning channel. Only send it when
      // the operator configured reasoningEffort — otherwise leave the
      // model on its own default (gpt-oss thinks, llama does not).
      if (config.reasoningEffort !== undefined) {
        body.think = config.reasoningEffort !== "none";
      }

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const { retryable, cascadable } = classifyOllamaError(undefined, err);
        onEvent({ type: "error", error, retryable, cascadable });
        return;
      }

      if (!res.ok || !res.body) {
        let detail = `Ollama /api/chat returned HTTP ${res.status}`;
        try {
          const text = await res.text();
          if (text) detail += `: ${text.slice(0, 300)}`;
        } catch {
          // best-effort; ignore body read failures
        }
        const { retryable, cascadable } = classifyOllamaError(res.status, undefined);
        onEvent({ type: "error", error: new Error(detail), retryable, cascadable });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleLine = (line: string): boolean => {
        // Returns false to signal the caller should stop (error emitted).
        let chunk: OllamaStreamChunk;
        try {
          chunk = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          return true; // skip an unparseable line rather than aborting
        }
        chunkCount++;

        if (chunk.error) {
          onEvent({
            type: "error",
            error: new Error(`Ollama: ${chunk.error}`),
            retryable: false,
            cascadable: true,
          });
          return false;
        }

        const msg = chunk.message;
        if (msg) {
          if (msg.content) {
            fullText += msg.content;
            onEvent({ type: "token", text: msg.content });
          }
          // Reasoning channel is counted for diagnostics but never folded
          // into the visible reply — same policy as the openai provider.
          if (typeof msg.thinking === "string" && msg.thinking.length > 0) {
            reasoningText += msg.thinking;
          }
          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              const argsObj = tc.function.arguments;
              toolCalls.push({
                // Ollama tool calls carry no id; synthesize a stable one
                // so the inference layer can pair the result message.
                id: `call_${toolCalls.length}_${Date.now().toString(36)}`,
                name: tc.function.name,
                arguments:
                  typeof argsObj === "string"
                    ? argsObj
                    : JSON.stringify(argsObj ?? {}),
              });
            }
          }
        }

        if (chunk.done) {
          if (typeof chunk.prompt_eval_count === "number") {
            promptTokens = chunk.prompt_eval_count;
          }
          if (typeof chunk.eval_count === "number") {
            completionTokens = chunk.eval_count;
          }
          if (chunk.done_reason) doneReason = chunk.done_reason;
        }
        return true;
      };

      try {
        let aborted = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line && !handleLine(line)) {
              aborted = true;
              break;
            }
          }
          if (aborted) break;
        }
        if (aborted) return;
        // Flush any trailing partial line (Ollama always newline-terminates,
        // but be defensive).
        const tail = buffer.trim();
        if (tail && !handleLine(tail)) return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const { retryable, cascadable } = classifyOllamaError(undefined, err);
        onEvent({ type: "error", error, retryable, cascadable });
        return;
      }

      if (toolCalls.length > 0) {
        onEvent({ type: "tool_call", toolCalls });
      }

      onEvent({
        type: "done",
        fullText,
        usage: { promptTokens, completionTokens },
        model: config.model,
        diagnostics: {
          chunkCount,
          finishReason: doneReason,
          reasoningChars: reasoningText.length,
          reasoningPreview:
            reasoningText.length > 0 ? reasoningText.slice(0, 200) : undefined,
        },
      });
    },
  };
}
