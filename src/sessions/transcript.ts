import type { TranscriptEntry, TrustMeta } from "./types.js";

export function createTranscriptEntry(
  role: TranscriptEntry["role"],
  content: string,
  trust: Partial<TrustMeta> = {},
): TranscriptEntry {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
    messageId: crypto.randomUUID(),
    trust: {
      source: trust.source ?? (role === "user" ? "user_input" : role === "assistant" ? "assistant" : "system"),
      sigilDetections: trust.sigilDetections ?? [],
      normalized: trust.normalized ?? false,
    },
  };
}

/**
 * Trim transcript to fit within a max entry count, keeping the most
 * recent entries. The system message (if first) is always preserved.
 */
export function trimTranscript(
  transcript: TranscriptEntry[],
  maxEntries: number,
): TranscriptEntry[] {
  if (transcript.length <= maxEntries) return transcript;

  // Preserve the first entry if it's a system message
  const first = transcript[0];
  if (first && first.role === "system") {
    return [first, ...transcript.slice(-(maxEntries - 1))];
  }

  return transcript.slice(-maxEntries);
}
