import { describe, it, expect } from "vitest";
import { StreamingLeakBuffer, detectLeaks, redactLeaks } from "./sanitize.js";

describe("StreamingLeakBuffer — edge cases", () => {
  it("detects pattern split across two chunks", () => {
    const buf = new StreamingLeakBuffer();

    // Split "sk-abcdefghijklmnopqrstuvwxyz" across two chunks
    buf.feed("The API key is sk-abcdefghij");
    const r2 = buf.feed("klmnopqrstuvwxyz and that's it");
    const flush = buf.flush();

    const allSafe = r2.safe + flush.safe;
    expect(allSafe).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(r2.leaks.length + flush.leaks.length).toBeGreaterThan(0);
  });

  it("detects pattern split across three chunks", () => {
    const buf = new StreamingLeakBuffer();

    buf.feed("key: sk-");
    buf.feed("abcdefghijklmno");
    buf.feed("pqrstuvwxyz done");
    const flush = buf.flush();

    // Assemble all safe output
    expect(flush.safe).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("handles empty token feeds", () => {
    const buf = new StreamingLeakBuffer();
    const r1 = buf.feed("");
    const r2 = buf.feed("");
    const r3 = buf.feed("Hello world");
    const flush = buf.flush();

    expect(r1.safe).toBe("");
    expect(r2.safe).toBe("");
    expect(r3.safe + flush.safe).toBe("Hello world");
  });

  it("handles single-character token feeds", () => {
    const buf = new StreamingLeakBuffer();
    const chars = "Hello world, no secrets here.".split("");
    let assembled = "";
    for (const c of chars) {
      const r = buf.feed(c);
      assembled += r.safe;
    }
    assembled += buf.flush().safe;
    expect(assembled).toBe("Hello world, no secrets here.");
  });

  it("detects capability ID in single token", () => {
    const buf = new StreamingLeakBuffer();
    const r = buf.feed("The tool cap_a1b2c3d4e5f6 was invoked");
    const flush = buf.flush();
    // Pattern may be caught in feed or flush depending on buffer size
    const allLeaks = [...r.leaks, ...flush.leaks];
    const allSafe = r.safe + flush.safe;
    expect(allLeaks.length).toBeGreaterThan(0);
    expect(allSafe).toContain("[REDACTED]");
  });

  it("detects GitHub PAT across chunk boundary", () => {
    const buf = new StreamingLeakBuffer();
    buf.feed("token ghp_abcdefghij");
    const r2 = buf.feed("klmnopqrstuvwxyz0123456789ABCDEF");
    const flush = buf.flush();

    const allSafe = r2.safe + flush.safe;
    const allLeaks = [...r2.leaks, ...flush.leaks];
    expect(allLeaks.length).toBeGreaterThan(0);
  });

  it("detects Slack token", () => {
    const buf = new StreamingLeakBuffer();
    const r = buf.feed("Use xoxb-12345678901-abcdefghijklmnop to connect");
    const flush = buf.flush();
    const allLeaks = [...r.leaks, ...flush.leaks];
    expect(allLeaks.some((l) => l.label === "slack_token")).toBe(true);
  });

  it("detects SIGIL_TRUST_BOUNDARY case-insensitively", () => {
    const buf = new StreamingLeakBuffer();
    const r = buf.feed("The sigil_trust_boundary marker appeared");
    const flush = buf.flush();
    const allLeaks = [...r.leaks, ...flush.leaks];
    expect(allLeaks.some((l) => l.label === "trust_boundary_tag")).toBe(true);
  });

  it("detects IRONCLAD_CONTEXT case-insensitively", () => {
    const buf = new StreamingLeakBuffer();
    const r = buf.feed("ironclad_context is a reserved tag");
    const flush = buf.flush();
    const allLeaks = [...r.leaks, ...flush.leaks];
    expect(allLeaks.some((l) => l.label === "ironclad_context_tag")).toBe(true);
  });

  it("handles large single token without crashing", () => {
    const buf = new StreamingLeakBuffer();
    const huge = "a".repeat(100_000);
    const r = buf.feed(huge);
    const flush = buf.flush();
    expect(r.safe.length + flush.safe.length).toBe(100_000);
    expect(r.leaks).toHaveLength(0);
  });

  it("redacts multiple patterns in same stream", () => {
    const buf = new StreamingLeakBuffer();
    buf.feed("keys: sk-aaaaaaaaaaaaaaaaaaaa and cap_a1b2c3d4e5f6");
    const flush = buf.flush();
    expect(flush.safe).not.toContain("sk-aaaa");
    expect(flush.safe).not.toContain("cap_a1b2c3d4e5f6");
    expect(flush.safe.match(/\[REDACTED\]/g)!.length).toBe(2);
  });

  it("does not false-positive on short sk- prefix", () => {
    const leaks = detectLeaks("I sketched a plan");
    expect(leaks).toHaveLength(0);
  });

  it("does not false-positive on 'skip' or 'skill'", () => {
    const leaks = detectLeaks("Let me skip to the next skill check");
    expect(leaks).toHaveLength(0);
  });
});

describe("detectLeaks — unicode evasion", () => {
  it("detects secrets with zero-width characters injected", () => {
    // Zero-width space (U+200B) injected into pattern
    const evasion = "sk-\u200Babcdefghijklmnopqrstuvwxyz";
    const leaks = detectLeaks(evasion);
    expect(leaks.length).toBeGreaterThan(0);
  });

  it("detects secrets with zero-width joiner", () => {
    const evasion = "cap_\u200Da1b2c3d4e5f6";
    const leaks = detectLeaks(evasion);
    expect(leaks.some((l) => l.label === "capability_id")).toBe(true);
  });

  it("detects IRONCLAD_CONTEXT with BOM character", () => {
    const evasion = "\uFEFFIRONCLAD_CONTEXT";
    const leaks = detectLeaks(evasion);
    expect(leaks.some((l) => l.label === "ironclad_context_tag")).toBe(true);
  });
});

describe("redactLeaks — completeness", () => {
  it("redacts all occurrences of a repeated pattern", () => {
    const input = "sk-aaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbb";
    const result = redactLeaks(input);
    expect(result).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(result.match(/\[REDACTED\]/g)!.length).toBe(2);
  });

  it("handles overlapping pattern regions", () => {
    // Two capability IDs adjacent
    const input = "cap_a1b2c3d4e5f6cap_f6e5d4c3b2a1";
    const result = redactLeaks(input);
    expect(result).not.toContain("cap_");
  });
});
