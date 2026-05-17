import { describe, it, expect } from "vitest";
import { createTranscriptEntry, trimTranscript } from "./transcript.js";
import type { TranscriptEntry } from "./types.js";

describe("createTranscriptEntry", () => {
  it("creates a user entry with correct defaults", () => {
    const entry = createTranscriptEntry("user", "Hello");
    expect(entry.role).toBe("user");
    expect(entry.content).toBe("Hello");
    expect(entry.messageId).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
    expect(entry.trust.source).toBe("user_input");
    expect(entry.trust.sigilDetections).toEqual([]);
    expect(entry.trust.normalized).toBe(false);
  });

  it("creates an assistant entry with correct defaults", () => {
    const entry = createTranscriptEntry("assistant", "Hi there");
    expect(entry.trust.source).toBe("assistant");
  });

  it("creates a system entry with correct defaults", () => {
    const entry = createTranscriptEntry("system", "System init");
    expect(entry.trust.source).toBe("system");
  });

  it("accepts partial trust overrides", () => {
    const entry = createTranscriptEntry("user", "test", {
      source: "tool_result",
      normalized: true,
    });
    expect(entry.trust.source).toBe("tool_result");
    expect(entry.trust.normalized).toBe(true);
    expect(entry.trust.sigilDetections).toEqual([]);
  });

  it("generates unique message IDs", () => {
    const a = createTranscriptEntry("user", "a");
    const b = createTranscriptEntry("user", "b");
    expect(a.messageId).not.toBe(b.messageId);
  });
});

describe("trimTranscript", () => {
  function makeEntry(role: TranscriptEntry["role"], content: string): TranscriptEntry {
    return createTranscriptEntry(role, content);
  }

  it("returns full transcript when within limit", () => {
    const entries = [makeEntry("user", "a"), makeEntry("assistant", "b")];
    expect(trimTranscript(entries, 5)).toEqual(entries);
  });

  it("trims to most recent entries", () => {
    const entries = [
      makeEntry("user", "1"),
      makeEntry("assistant", "2"),
      makeEntry("user", "3"),
      makeEntry("assistant", "4"),
    ];
    const trimmed = trimTranscript(entries, 2);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0]!.content).toBe("3");
    expect(trimmed[1]!.content).toBe("4");
  });

  it("preserves system message at index 0 when trimming", () => {
    const entries = [
      makeEntry("system", "sys"),
      makeEntry("user", "1"),
      makeEntry("assistant", "2"),
      makeEntry("user", "3"),
      makeEntry("assistant", "4"),
    ];
    const trimmed = trimTranscript(entries, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed[0]!.role).toBe("system");
    expect(trimmed[0]!.content).toBe("sys");
    expect(trimmed[2]!.content).toBe("4");
  });

  it("returns empty array when input is empty", () => {
    expect(trimTranscript([], 5)).toEqual([]);
  });
});
