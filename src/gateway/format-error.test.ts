import { describe, it, expect } from "vitest";
import { humanizeInferenceError } from "./format-error.js";

describe("humanizeInferenceError", () => {
  it("rewrites Ollama tool-call JSON parse errors into a human hint", () => {
    const raw =
      "500 error parsing tool call: raw='{\"path\":\"x.md\",\"content\":\"\\$900\"}', err=invalid character '$' in string escape code";
    const out = humanizeInferenceError(raw);

    // Should NOT echo the raw blob back at the user.
    expect(out).not.toContain("raw='");
    expect(out).not.toContain("invalid character");
    // Should mention the actual cause and an actionable next step.
    expect(out).toMatch(/malformed JSON/i);
    expect(out).toMatch(/model swap|resending|retry/i);
  });

  it("rewrites 'does not support tools' with a /model swap hint", () => {
    const raw = "400 registry.ollama.ai/library/cydonia-24b:latest does not support tools";
    const out = humanizeInferenceError(raw);

    expect(out).not.toContain("registry.ollama.ai");
    expect(out).toMatch(/doesn't support tool calls/i);
    expect(out).toMatch(/model swap/i);
  });

  it("rewrites 'model not found' with a pull hint", () => {
    const out = humanizeInferenceError("model not found: nope:latest");
    expect(out).toMatch(/ollama pull/i);
  });

  it("rewrites EMPTY_RESPONSE-style messages with a model-swap hint", () => {
    const raw =
      "The active model produced no output (zero tokens, zero tool calls) on two consecutive turns.";
    const out = humanizeInferenceError(raw);
    expect(out).toMatch(/went silent|no text/i);
    expect(out).toMatch(/model swap/i);
  });

  it("falls through with truncation when no pattern matches", () => {
    const long = "z".repeat(1000);
    const out = humanizeInferenceError(long, 50);

    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("truncated");
  });

  it("returns short unmatched messages verbatim", () => {
    const raw = "connection refused";
    expect(humanizeInferenceError(raw)).toBe("connection refused");
  });
});
