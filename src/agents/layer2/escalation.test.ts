import { describe, it, expect } from "vitest";
import { detectEscalation, EscalationLeadBuffer } from "./escalation.js";

const DEFAULT_MARKERS = [
  "I'm not sure",
  "I don't know",
  "I cannot determine",
  "you should ask",
  "beyond my capability",
  "I need more context",
  "this is complex",
  "I'm unable to",
];

describe("detectEscalation", () => {
  it("detects default escalation markers (case-insensitive)", () => {
    const result = detectEscalation("I'M NOT SURE what you mean by that.", DEFAULT_MARKERS);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("I'm not sure");
  });

  it("detects 'I need more context' marker", () => {
    const result = detectEscalation("I need more context to answer that properly.", DEFAULT_MARKERS);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("I need more context");
  });

  it("does not flag confident responses", () => {
    const result = detectEscalation(
      "You have 12 TypeScript files in the src/ directory.",
      DEFAULT_MARKERS,
    );
    expect(result.shouldEscalate).toBe(false);
    expect(result.matchedMarker).toBeUndefined();
  });

  it("detects empty responses as escalation", () => {
    const result = detectEscalation("", DEFAULT_MARKERS);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("__empty_response");
  });

  it("detects whitespace-only responses as escalation", () => {
    const result = detectEscalation("   \n  ", DEFAULT_MARKERS);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("__empty_response");
  });

  it("detects very short responses as escalation", () => {
    const result = detectEscalation("Hmm", DEFAULT_MARKERS);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("__empty_response");
  });

  it("respects custom markers", () => {
    const customMarkers = ["ESCALATE_NOW"];
    const result = detectEscalation("This requires ESCALATE_NOW please.", customMarkers);
    expect(result.shouldEscalate).toBe(true);
    expect(result.matchedMarker).toBe("ESCALATE_NOW");
  });

  it("handles empty marker list", () => {
    const result = detectEscalation("I'm not sure about this.", []);
    expect(result.shouldEscalate).toBe(false);
  });

  it("does not flag disambiguation questions as escalation", () => {
    const result = detectEscalation(
      "Did you mean to rename the files or delete them?",
      DEFAULT_MARKERS,
    );
    expect(result.shouldEscalate).toBe(false);
  });
});

describe("EscalationLeadBuffer", () => {
  it("buffers chunks until the lead fills, then commits clean", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 50);
    expect(buf.feed("The repo has ")).toBe("");
    expect(buf.feed("12 TypeScript files. ")).toBe("");
    // 50-char threshold crossed by this chunk; clean lead returned.
    const out = buf.feed("Most of them live in src/agents/layer2/.");
    expect(out).toContain("The repo has");
    expect(buf.didDetectEscalation).toBe(false);
  });

  it("swallows the lead and reports escalation when a marker appears in the lead", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 30);
    expect(buf.feed("I'm not sure ")).toBe("");
    // 30-char threshold crossed; lead is swallowed (returns empty).
    expect(buf.feed("what you mean by that.")).toBe("");
    expect(buf.didDetectEscalation).toBe(true);
    expect(buf.matchedMarker).toBe("I'm not sure");
  });

  it("forces a decision on stream-end via decide() for short clean responses", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 200);
    expect(buf.feed("Yes — 12 files.")).toBe("");
    const { matchedMarker, lead } = buf.decide();
    expect(matchedMarker).toBe(null);
    expect(lead).toBe("Yes — 12 files.");
  });

  it("forces a decision on stream-end via decide() for short escalation responses", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 200);
    expect(buf.feed("I'm not sure about that.")).toBe("");
    const { matchedMarker } = buf.decide();
    expect(matchedMarker).toBe("I'm not sure");
    expect(buf.didDetectEscalation).toBe(true);
  });

  it("passes chunks through unchanged after a clean decision", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 20);
    // First chunk crosses the threshold, returns the buffered lead.
    const first = buf.feed("Files exist in src/.");
    expect(first.length).toBeGreaterThan(0);
    // Subsequent chunks pass through untouched.
    expect(buf.feed(" More text.")).toBe(" More text.");
  });

  it("decide() is idempotent — second call after a mid-stream decision returns cleared lead", () => {
    const buf = new EscalationLeadBuffer(DEFAULT_MARKERS, 20);
    buf.feed("Files exist in src/.");
    const first = buf.decide();
    const second = buf.decide();
    expect(second.matchedMarker).toBe(first.matchedMarker);
    expect(second.lead).toBe("");
  });
});
