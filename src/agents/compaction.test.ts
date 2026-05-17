import { describe, it, expect, vi } from "vitest";
import { compactHistory } from "./compaction.js";
import { createTranscriptEntry } from "../sessions/transcript.js";
import type { TranscriptEntry } from "../sessions/types.js";
import type { Provider } from "./providers/types.js";

function makeEntries(count: number, contentSize: number = 100): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    entries.push(
      createTranscriptEntry(role as "user" | "assistant", "X".repeat(contentSize), {
        source: role === "user" ? "user_input" : "assistant",
      }),
    );
  }
  return entries;
}

function mockProvider(summaryText: string = "Summary of conversation"): Provider {
  return {
    id: "mock",
    type: "openai",
    async stream(req, onEvent) {
      onEvent({ type: "token", text: summaryText });
      onEvent({ type: "done", fullText: summaryText });
    },
  };
}

describe("compactHistory", () => {
  it("returns transcript unchanged when under budget", async () => {
    const entries = makeEntries(4, 20); // ~5 tokens each = ~20 total
    const result = await compactHistory(entries, 10000, mockProvider(), "model");
    expect(result).toBe(entries); // same reference = no compaction
  });

  it("compacts old entries when over budget", async () => {
    const entries = makeEntries(10, 200); // ~50 tokens each = ~500 total
    const provider = mockProvider("This is the summary");
    const result = await compactHistory(entries, 200, provider, "model");

    // Should be shorter than original
    expect(result.length).toBeLessThan(entries.length);

    // First entry should be the compacted summary
    expect(result[0]!.role).toBe("system");
    expect(result[0]!.content).toContain("[COMPACTION METADATA");
    expect(result[0]!.content).toContain("This is the summary");
  });

  it("summary entry has correct trust metadata", async () => {
    const entries = makeEntries(10, 200);
    const result = await compactHistory(entries, 200, mockProvider(), "model");

    const summary = result[0]!;
    expect(summary.trust.source).toBe("system");
  });

  it("preserves recent entries after compaction", async () => {
    const entries = makeEntries(10, 200);
    const lastEntry = entries[entries.length - 1]!;
    const result = await compactHistory(entries, 200, mockProvider(), "model");

    // The most recent entry should still be present
    const lastResult = result[result.length - 1]!;
    expect(lastResult.content).toBe(lastEntry.content);
  });

  it("falls back to hard truncation on provider error", async () => {
    const entries = makeEntries(10, 200);
    const failingProvider: Provider = {
      id: "fail",
      type: "openai",
      async stream(_req, onEvent) {
        onEvent({ type: "error", error: new Error("Provider down"), retryable: false });
      },
    };

    const result = await compactHistory(entries, 200, failingProvider, "model");
    // Hard truncation keeps newest entries that fit within budget
    expect(result.length).toBeLessThan(entries.length);
    expect(result.length).toBeGreaterThan(0);
    // Most recent entry preserved
    expect(result[result.length - 1]!.content).toBe(entries[entries.length - 1]!.content);
  });

  it("includes deterministic metadata header with message counts", async () => {
    const entries = makeEntries(10, 200);
    const result = await compactHistory(entries, 200, mockProvider(), "model");

    const summary = result[0]!.content;
    expect(summary).toContain("[COMPACTION METADATA");
    expect(summary).toContain("deterministic");

    // Parse the metadata JSON between the header and the summary section
    const metaMatch = summary.match(
      /\[COMPACTION METADATA[^\]]*\]\n([\s\S]*?)\n\n\[/,
    );
    expect(metaMatch).not.toBeNull();
    const meta = JSON.parse(metaMatch![1]!);
    expect(meta.messageCountByRole).toBeDefined();
    expect(meta.messageCountByRole.user).toBeGreaterThan(0);
    expect(meta.messageCountByRole.assistant).toBeGreaterThan(0);
  });

  it("counts tool entries correctly in metadata", async () => {
    // Use many entries with large content so both tool entries end up in compacted region
    const entries: TranscriptEntry[] = [
      createTranscriptEntry("user", "X".repeat(200), { source: "user_input" }),
      createTranscriptEntry("assistant", "X".repeat(200), { source: "assistant" }),
      createTranscriptEntry("tool", "X".repeat(200), { source: "tool_result" }),
      createTranscriptEntry("tool", "X".repeat(200), { source: "tool_result" }),
      createTranscriptEntry("user", "X".repeat(200), { source: "user_input" }),
      createTranscriptEntry("assistant", "X".repeat(200), { source: "assistant" }),
      createTranscriptEntry("user", "X".repeat(200), { source: "user_input" }),
      createTranscriptEntry("assistant", "X".repeat(200), { source: "assistant" }),
    ];
    // Budget of 150 forces heavy compaction — only ~3 entries kept
    const result = await compactHistory(entries, 150, mockProvider(), "model");

    const metaMatch = result[0]!.content.match(
      /\[COMPACTION METADATA[^\]]*\]\n([\s\S]*?)\n\n\[/,
    );
    const meta = JSON.parse(metaMatch![1]!);
    expect(meta.toolCallCount).toBe(2);
  });

  it("produces STRUCTURED SUMMARY when LLM returns valid JSON", async () => {
    const jsonSummary = JSON.stringify({
      keyFacts: ["fact1"],
      decisions: ["decision1"],
      toolResults: [],
      pendingWork: [],
      narrative: "A brief conversation.",
    });
    const entries = makeEntries(10, 200);
    const result = await compactHistory(
      entries,
      200,
      mockProvider(jsonSummary),
      "model",
    );

    expect(result[0]!.content).toContain("[STRUCTURED SUMMARY]");
    expect(result[0]!.content).toContain("fact1");
  });

  it("falls back to SUMMARY when LLM returns non-JSON", async () => {
    const entries = makeEntries(10, 200);
    const result = await compactHistory(
      entries,
      200,
      mockProvider("Just a plain text summary"),
      "model",
    );

    expect(result[0]!.content).toContain("[SUMMARY]");
    expect(result[0]!.content).toContain("Just a plain text summary");
    expect(result[0]!.content).not.toContain("[STRUCTURED SUMMARY]");
  });
});
