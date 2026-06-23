import { describe, it, expect } from "vitest";
import { buildContextWindow, estimateTokens } from "./context.js";
import type { AgentConfig } from "../config/types.js";
import type { TranscriptEntry } from "../sessions/types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test",
    name: "Test",
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

describe("estimateTokens — edge cases", () => {
  it("handles single character", () => {
    expect(estimateTokens("a")).toBe(1); // ceil(1/3.5) = 1
  });

  it("scales CJK characters by UTF-8 byte length", () => {
    const cjk = "你好世界"; // 4 chars, each 3 bytes in UTF-8 = 12 bytes
    const estimate = estimateTokens(cjk);
    // ceil(12 / 3.5) = 4. Still not a true tokenizer (real count is
    // typically 4-8), but far closer than the old 2 based on JS length.
    expect(estimate).toBe(4);
  });

  it("scales emoji by UTF-8 byte length", () => {
    const estimate = estimateTokens("😀😀😀😀");
    // 4 emoji × 4 UTF-8 bytes each = 16 bytes; ceil(16/3.5) = 5.
    // Old behaviour (JS length) returned 3 because it counted 8
    // UTF-16 code units instead of 16 bytes.
    expect(estimate).toBe(5);
  });
});

describe("buildContextWindow — edge cases", () => {
  it("handles empty system prompt (IRONCLAD_CONTEXT still present)", () => {
    const agent = makeAgent({ systemPrompt: "" });
    const ctx = buildContextWindow(agent, [], 10000);
    expect(ctx.messages[0]!.content).toContain("IRONCLAD_CONTEXT");
    expect(ctx.messages[0]!.content).toContain("HISTORY TRUST NOTICE");
    expect(ctx.messages[0]!.content.length).toBeGreaterThan(0);
  });

  it("drops newest message when it alone exceeds history budget", () => {
    const agent = makeAgent({ systemPrompt: "Short." });
    // System prompt with IRONCLAD + trust notice ~950 chars = ~238 tokens
    // Budget = 250 → only ~12 tokens for history
    // Message = 200 chars = 50 tokens → exceeds budget
    const transcript = [makeEntry("user", "X".repeat(200))];
    const ctx = buildContextWindow(agent, transcript, 250);
    expect(ctx.messages).toHaveLength(1); // only system
    expect(ctx.truncated).toBe(true);
  });

  it("handles system prompt alone exceeding budget", () => {
    const agent = makeAgent({ systemPrompt: "X".repeat(10000) });
    const transcript = [makeEntry("user", "Hello")];
    const ctx = buildContextWindow(agent, transcript, 100);
    expect(ctx.messages[0]!.role).toBe("system");
    expect(ctx.truncated).toBe(true);
    expect(ctx.messages).toHaveLength(1);
  });

  it("preserves message ordering (oldest to newest)", () => {
    const agent = makeAgent();
    const transcript = [
      makeEntry("user", "msg-1"),
      makeEntry("assistant", "msg-2"),
      makeEntry("user", "msg-3"),
      makeEntry("assistant", "msg-4"),
    ];
    const ctx = buildContextWindow(agent, transcript, 100000);
    expect(ctx.messages[1]!.content).toBe("msg-1");
    expect(ctx.messages[2]!.content).toBe("msg-2");
    expect(ctx.messages[3]!.content).toBe("msg-3");
    expect(ctx.messages[4]!.content).toBe("msg-4");
  });

  it("keeps newest messages when truncating", () => {
    const agent = makeAgent({ systemPrompt: "S" });
    // System prompt with IRONCLAD (now first) ≈ 1100 chars ≈ 315 tokens
    // Each message = 200 chars = ~57 tokens
    // Budget = 500 → ~185 tokens for history → fits 3 messages (171), not 4 (228)
    const transcript = [
      makeEntry("user", "A".repeat(200)),       // oldest — should be dropped
      makeEntry("assistant", "B".repeat(200)),  // kept
      makeEntry("user", "C".repeat(200)),        // kept
      makeEntry("assistant", "D".repeat(200)),  // newest — should be kept
    ];
    const ctx = buildContextWindow(agent, transcript, 500);
    expect(ctx.truncated).toBe(true);
    const historyContents = ctx.messages.slice(1).map((m) => m.content);
    expect(historyContents.length).toBeGreaterThanOrEqual(1);
    expect(historyContents[historyContents.length - 1]).toBe("D".repeat(200));
  });

  it("keeps tool entries with tool role for native provider API", () => {
    const agent = makeAgent();
    const transcript = [
      makeEntry("user", "search for X"),
      makeEntry("tool", '{"results": [1,2,3]}'),
      makeEntry("tool", '{"results": [4,5,6]}'),
      makeEntry("assistant", "Found results."),
    ];
    const ctx = buildContextWindow(agent, transcript, 100000);
    expect(ctx.messages[2]!.role).toBe("tool");
    expect(ctx.messages[3]!.role).toBe("tool");
  });

  it("includes tool declarations in system prompt when provided", () => {
    const agent = makeAgent();
    const declarations = [
      { name: "cap_abc123def456", description: "Search the web", parameters: {} },
    ];
    const ctx = buildContextWindow(agent, [], 10000, declarations);
    expect(ctx.messages[0]!.content).toContain("AVAILABLE_TOOLS");
    expect(ctx.messages[0]!.content).toContain("cap_abc123def456");
    expect(ctx.messages[0]!.content).toContain("Search the web");
  });
});
