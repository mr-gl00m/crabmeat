import { describe, it, expect } from "vitest";
import { buildContextWindow, estimateTokens } from "./context.js";
import type { AgentConfig } from "../config/types.js";
import type { TranscriptEntry } from "../sessions/types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test",
    name: "Test Agent",
    systemPrompt: "You are a test agent.",
    temperature: 0.7,
    maxTokens: 4096,
    charsPerToken: 3.5,
    strictInstructions: false,
    tools: [],
    allowedEffects: ["read"],
    maxToolIterations: 5,
    ...overrides,
  };
}

function makeEntry(role: TranscriptEntry["role"], content: string): TranscriptEntry {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
    messageId: crypto.randomUUID(),
    trust: { source: "user_input", sigilDetections: [], normalized: false },
  };
}

describe("estimateTokens", () => {
  it("estimates ~1 token per 3.5 characters", () => {
    // 4 chars / 3.5 = 1.14 → ceil = 2
    expect(estimateTokens("abcd")).toBe(2);
    // 7 chars / 3.5 = 2
    expect(estimateTokens("abcdefg")).toBe(2);
    // 8 chars / 3.5 = 2.28 → ceil = 3
    expect(estimateTokens("12345678")).toBe(3);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("buildContextWindow", () => {
  it("always includes system prompt as first message", () => {
    const agent = makeAgent();
    const ctx = buildContextWindow(agent, [], 10000);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.messages[0]!.content).toContain("You are a test agent.");
    expect(ctx.messages[0]!.content).toContain("HISTORY TRUST NOTICE");
  });

  it("includes IRONCLAD_CONTEXT in system prompt", () => {
    const agent = makeAgent();
    const ctx = buildContextWindow(agent, [], 10000);
    expect(ctx.messages[0]!.content).toContain("IRONCLAD_CONTEXT");
  });

  it("includes transcript messages after system prompt", () => {
    const agent = makeAgent();
    const transcript = [
      makeEntry("user", "Hello"),
      makeEntry("assistant", "Hi!"),
    ];
    const ctx = buildContextWindow(agent, transcript, 10000);
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[1]!.role).toBe("user");
    expect(ctx.messages[1]!.content).toBe("Hello");
    expect(ctx.messages[2]!.role).toBe("assistant");
    expect(ctx.messages[2]!.content).toBe("Hi!");
  });

  it("truncates oldest messages when budget exceeded", () => {
    const agent = makeAgent({ systemPrompt: "Sys" });
    // System prompt with IRONCLAD + capability awareness + trust notice ≈ 330 tokens
    // Each entry = 400 chars ≈ 100 tokens
    // Budget = 650 tokens → ~320 for history → fits 2-3 entries, not all 4
    const transcript = [
      makeEntry("user", "A".repeat(400)),       // 100 tokens
      makeEntry("assistant", "B".repeat(400)),   // 100 tokens
      makeEntry("user", "C".repeat(400)),        // 100 tokens
      makeEntry("assistant", "D".repeat(400)),   // 100 tokens
    ];
    const ctx = buildContextWindow(agent, transcript, 650);
    expect(ctx.truncated).toBe(true);
    expect(ctx.messages.length).toBeGreaterThanOrEqual(2); // system + at least 1 history
    expect(ctx.messages.length).toBeLessThan(5); // not all 4 history entries
    expect(ctx.messages[0]!.role).toBe("system");
  });

  it("sets truncated=false when all messages fit", () => {
    const agent = makeAgent();
    const transcript = [makeEntry("user", "Hi")];
    const ctx = buildContextWindow(agent, transcript, 100000);
    expect(ctx.truncated).toBe(false);
  });

  it("keeps tool entries with tool role for native tool use", () => {
    const agent = makeAgent();
    const transcript = [makeEntry("tool", "result data")];
    const ctx = buildContextWindow(agent, transcript, 10000);
    expect(ctx.messages[1]!.role).toBe("tool");
    expect(ctx.messages[1]!.content).toBe("result data");
  });

  it("reports token count", () => {
    const agent = makeAgent();
    const transcript = [makeEntry("user", "Hello world")];
    const ctx = buildContextWindow(agent, transcript, 10000);
    expect(ctx.totalTokens).toBeGreaterThan(0);
  });

  it("handles empty transcript", () => {
    const agent = makeAgent();
    const ctx = buildContextWindow(agent, [], 10000);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.truncated).toBe(false);
  });
});
