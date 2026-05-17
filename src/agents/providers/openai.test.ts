import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderConfig } from "../../config/types.js";
import type { ProviderRequest, StreamEvent } from "./types.js";

const capturedRequests: Record<string, unknown>[] = [];

vi.mock("openai", () => {
  // Minimal stub that captures the request body and yields a single
  // empty done chunk so the stream consumer exits cleanly.
  class FakeOpenAI {
    chat = {
      completions: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          capturedRequests.push(body);
          async function* gen() {
            yield {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0 },
            };
          }
          return gen();
        }),
      },
    };
    constructor(_opts: unknown) {}
  }
  // The provider also references OpenAI.APIError in its catch block
  // (rescueOllamaToolCallError). Stub a minimal subclass so instanceof
  // checks don't throw.
  (FakeOpenAI as unknown as { APIError: typeof Error }).APIError = class extends Error {
    status?: number;
  };
  return { default: FakeOpenAI };
});

import { createOpenAIProvider } from "./openai.js";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "test-provider",
    type: "openai",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com",
    model: "real-model",
    maxRetries: 0,
    timeoutMs: 1000,
    ...overrides,
  } as ProviderConfig;
}

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "real-model",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
    temperature: 0.5,
    ...overrides,
  } as ProviderRequest;
}

async function callStream(provider: ReturnType<typeof createOpenAIProvider>, req: ProviderRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await provider.stream(req, (e) => events.push(e));
  return events;
}

describe("createOpenAIProvider — RT-2026-04-30-001 providerOptions cannot override request fields", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("ignores providerOptions.model — explicit request.model wins", async () => {
    const cfg = makeConfig({
      providerOptions: { model: "ATTACKER-MODEL" },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(provider, makeRequest({ model: "real-model" }));

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.model).toBe("real-model");
  });

  it("ignores providerOptions.messages — explicit request.messages wins", async () => {
    const cfg = makeConfig({
      providerOptions: {
        messages: [{ role: "user", content: "EXFILTRATION PROMPT" }],
      },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(
      provider,
      makeRequest({ messages: [{ role: "user", content: "real prompt" }] }),
    );

    const body = capturedRequests[0]!;
    expect(body.messages).toEqual([{ role: "user", content: "real prompt" }]);
  });

  it("ignores providerOptions.max_tokens — explicit request.maxTokens wins", async () => {
    const cfg = makeConfig({
      providerOptions: { max_tokens: 1 },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(provider, makeRequest({ maxTokens: 9999 }));

    expect(capturedRequests[0]!.max_tokens).toBe(9999);
  });

  it("ignores providerOptions.temperature — explicit request.temperature wins", async () => {
    const cfg = makeConfig({
      providerOptions: { temperature: 1.9 },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(provider, makeRequest({ temperature: 0.1 }));

    expect(capturedRequests[0]!.temperature).toBe(0.1);
  });

  it("ignores providerOptions.tools — explicit request.tools wins", async () => {
    const cfg = makeConfig({
      providerOptions: {
        tools: [
          {
            type: "function",
            function: { name: "ATTACKER_TOOL", parameters: {} },
          },
        ],
      },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(
      provider,
      makeRequest({
        tools: [
          {
            name: "real_tool",
            description: "real",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const body = capturedRequests[0]! as { tools?: Array<{ function: { name: string } }> };
    expect(body.tools).toBeDefined();
    expect(body.tools![0]!.function.name).toBe("real_tool");
  });

  it("preserves legitimate providerOptions.options (Ollama num_ctx use case)", async () => {
    const cfg = makeConfig({
      providerOptions: { options: { num_ctx: 32768 } },
    });
    const provider = createOpenAIProvider(cfg);
    await callStream(provider, makeRequest());

    const body = capturedRequests[0]! as { options?: { num_ctx: number } };
    expect(body.options).toEqual({ num_ctx: 32768 });
    expect(body.model).toBe("real-model");
  });
});
