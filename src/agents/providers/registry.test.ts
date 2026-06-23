import { describe, it, expect, vi } from "vitest";
import { createProviderRegistry } from "./registry.js";
import type { ProviderConfig } from "../../config/types.js";

// Mock the actual SDK provider factories to avoid real SDK initialization
vi.mock("./openai.js", () => ({
  createOpenAIProvider: vi.fn((config: ProviderConfig) => ({
    id: config.id,
    type: "openai" as const,
    stream: vi.fn(),
  })),
}));

vi.mock("./anthropic.js", () => ({
  createAnthropicProvider: vi.fn((config: ProviderConfig) => ({
    id: config.id,
    type: "anthropic" as const,
    stream: vi.fn(),
  })),
}));

describe("createProviderRegistry", () => {
  it("creates OpenAI providers", () => {
    const providers = createProviderRegistry([
      { id: "oai", type: "openai", apiKey: "sk-test", model: "gpt-4.1", maxRetries: 2, timeoutMs: 60000 },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe("oai");
    expect(providers[0]!.type).toBe("openai");
  });

  it("creates Anthropic providers", () => {
    const providers = createProviderRegistry([
      { id: "claude", type: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-4-6", maxRetries: 2, timeoutMs: 60000 },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe("claude");
    expect(providers[0]!.type).toBe("anthropic");
  });

  it("preserves order (primary + failover)", () => {
    const providers = createProviderRegistry([
      { id: "primary", type: "openai", apiKey: "sk-1", model: "gpt-4.1", maxRetries: 2, timeoutMs: 60000 },
      { id: "fallback", type: "anthropic", apiKey: "sk-2", model: "claude-sonnet-4-6", maxRetries: 2, timeoutMs: 60000 },
    ]);
    expect(providers).toHaveLength(2);
    expect(providers[0]!.id).toBe("primary");
    expect(providers[1]!.id).toBe("fallback");
  });

  it("returns empty array for empty config", () => {
    const providers = createProviderRegistry([]);
    expect(providers).toEqual([]);
  });
});
