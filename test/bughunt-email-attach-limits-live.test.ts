// Regression test for BH-2026-05-10-002 (bug-hunt 2026-05-10).
// Invariant (from src/agents/tools/email-attach.ts docstring on the
// MAX_ATTACHMENT_BYTES export): "They report the current live values;
// tests that read them get the override when one is set, or the default
// otherwise."
// Original code: `export const MAX_ATTACHMENT_BYTES = DEFAULT_...` —
// const exports are frozen at module load and never updated.
// Fix: re-export the mutable `let` bindings via `export { x as Name }`.
// ES modules re-export `let` bindings live, so importers see updates.
import { describe, it, expect, afterEach } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
  setEmailAttachmentLimits,
  getEmailAttachmentLimits,
  _resetEmailAttachState,
} from "../src/agents/tools/email-attach.js";

describe("BH-2026-05-10-002: MAX_ATTACHMENT_BYTES backwards-compat exports", () => {
  afterEach(() => {
    _resetEmailAttachState();
  });

  it("MAX_ATTACHMENT_BYTES tracks the live override per the docstring", () => {
    const overrideMaxBytes = 10 * 1024 * 1024;
    const overrideTotal = 40 * 1024 * 1024;
    setEmailAttachmentLimits({
      maxBytes: overrideMaxBytes,
      totalMaxBytes: overrideTotal,
    });
    const live = getEmailAttachmentLimits();
    expect(live.maxBytes, "live limits should reflect override").toBe(
      overrideMaxBytes,
    );
    expect(live.totalMaxBytes).toBe(overrideTotal);
    expect(
      MAX_ATTACHMENT_BYTES,
      `MAX_ATTACHMENT_BYTES should track live override per its docstring; ` +
        `got ${MAX_ATTACHMENT_BYTES}, expected ${overrideMaxBytes}.`,
    ).toBe(overrideMaxBytes);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(overrideTotal);
  });

  it("(reference) DEFAULT_* constants are frozen at module-load values", () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});
