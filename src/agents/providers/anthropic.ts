import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../../config/types.js";
import type {
  Provider,
  ProviderRequest,
  StreamEvent,
  ChatMessage,
  ToolCallRequest,
} from "./types.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: config.timeoutMs,
  });

  return {
    id: config.id,
    type: "anthropic",
    model: config.model,
    baseUrl: config.baseUrl,
    role: config.role,

    async stream(request: ProviderRequest, onEvent: (event: StreamEvent) => void) {
      let fullText = "";

      // Anthropic separates system from messages
      const systemMessage = request.messages.find((m) => m.role === "system");
      const nonSystemMessages = request.messages
        .filter((m): m is ChatMessage & { role: "user" | "assistant" | "tool" } => m.role !== "system");

      // Build Anthropic messages, mapping tool results to their format
      const messages = nonSystemMessages.map((m) => {
        if (m.role === "tool" && m.toolCallId) {
          return {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: m.toolCallId,
                content: m.content,
              },
            ],
          };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          const content: Array<
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input: unknown }
          > = [];
          if (m.content) {
            content.push({ type: "text", text: m.content });
          }
          for (const tc of m.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: JSON.parse(tc.arguments),
            });
          }
          return { role: "assistant" as const, content };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content,
        };
      });

      // Build Anthropic tool declarations
      const tools = request.tools?.length
        ? request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
          }))
        : undefined;

      try {
        // Use structured system blocks for prompt caching when available
        const systemContent = request.systemBlocks?.length
          ? request.systemBlocks.map((block) => ({
              type: "text" as const,
              text: block.text,
              ...(block.cacheControl
                ? { cache_control: { type: block.cacheControl as "ephemeral" } }
                : {}),
            }))
          : systemMessage?.content;

        const stream = client.messages.stream({
          model: request.model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          system: systemContent as Parameters<typeof client.messages.stream>[0]["system"],
          messages,
          ...(tools ? { tools } : {}),
        });

        // Track tool use blocks as they stream in
        const pendingToolCalls: ToolCallRequest[] = [];
        let currentToolId = "";
        let currentToolName = "";
        let currentToolInput = "";

        stream.on("text", (text) => {
          fullText += text;
          onEvent({ type: "token", text });
        });

        stream.on("contentBlock", (block) => {
          if (block.type === "tool_use") {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolInput = JSON.stringify(block.input);
            pendingToolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolInput,
            });
          }
        });

        const finalMessage = await stream.finalMessage();

        // Emit tool calls if any were accumulated
        if (pendingToolCalls.length > 0) {
          onEvent({ type: "tool_call", toolCalls: pendingToolCalls });
        }

        // The Anthropic SDK types cache_* fields as optional numbers —
        // some API versions omit them entirely for non-cached requests.
        // Destructure with a loose cast and default to 0 so the cost
        // tracker always sees well-formed values.
        const rawUsage = finalMessage.usage as {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        };
        onEvent({
          type: "done",
          fullText,
          usage: {
            promptTokens: rawUsage.input_tokens,
            completionTokens: rawUsage.output_tokens,
            cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
          },
          model: config.model,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const retryable = isRetryableAnthropicError(err);
        onEvent({ type: "error", error, retryable });
      }
    },
  };
}

function isRetryableAnthropicError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status === 529 || (err.status !== undefined && err.status >= 500);
  }
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) return true;
  return false;
}
