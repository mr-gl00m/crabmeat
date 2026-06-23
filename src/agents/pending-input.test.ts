import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueuePendingInput,
  drainPendingInput,
  peekPendingInput,
  pendingInputCount,
  clearPendingInput,
  isControlKillToken,
  _resetPendingInput,
  _pendingInputTotal,
  MAX_PENDING_PER_SESSION,
  MAX_PENDING_CONTENT_LEN,
} from "./pending-input.js";

beforeEach(() => {
  _resetPendingInput();
});

describe("pending-input buffer", () => {
  it("enqueue → peek → drain FIFO", () => {
    expect(enqueuePendingInput("s1", "a")).toBe(1);
    expect(enqueuePendingInput("s1", "b")).toBe(2);
    expect(enqueuePendingInput("s1", "c")).toBe(3);
    expect(pendingInputCount("s1")).toBe(3);
    const peeked = peekPendingInput("s1").map((e) => e.content);
    expect(peeked).toEqual(["a", "b", "c"]);
    const drained = drainPendingInput("s1").map((e) => e.content);
    expect(drained).toEqual(["a", "b", "c"]);
    expect(pendingInputCount("s1")).toBe(0);
  });

  it("drain empty returns []", () => {
    expect(drainPendingInput("s1")).toEqual([]);
  });

  it("sessions are isolated", () => {
    enqueuePendingInput("a", "a1");
    enqueuePendingInput("b", "b1");
    enqueuePendingInput("b", "b2");
    expect(pendingInputCount("a")).toBe(1);
    expect(pendingInputCount("b")).toBe(2);
    const drainedA = drainPendingInput("a").map((e) => e.content);
    expect(drainedA).toEqual(["a1"]);
    expect(pendingInputCount("b")).toBe(2);
  });

  it("rejects empty and non-string content", () => {
    expect(enqueuePendingInput("s1", "")).toBe(-1);
    expect(enqueuePendingInput("s1", null as unknown as string)).toBe(-1);
    expect(enqueuePendingInput("", "hi")).toBe(-1);
  });

  it("truncates content over the max length", () => {
    const huge = "x".repeat(MAX_PENDING_CONTENT_LEN * 2);
    enqueuePendingInput("s1", huge);
    const drained = drainPendingInput("s1");
    expect(drained[0]!.content.length).toBe(MAX_PENDING_CONTENT_LEN);
  });

  it("rejects overflow beyond MAX_PENDING_PER_SESSION", () => {
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      expect(enqueuePendingInput("s1", `m${i}`)).toBe(i + 1);
    }
    expect(enqueuePendingInput("s1", "overflow")).toBe(-1);
    expect(pendingInputCount("s1")).toBe(MAX_PENDING_PER_SESSION);
  });

  it("clearPendingInput wipes a session's queue", () => {
    enqueuePendingInput("s1", "a");
    enqueuePendingInput("s1", "b");
    expect(clearPendingInput("s1")).toBe(2);
    expect(pendingInputCount("s1")).toBe(0);
    expect(clearPendingInput("s1")).toBe(0);
  });

  it("entries carry a timestamp", () => {
    const before = Date.now();
    enqueuePendingInput("s1", "hi");
    const after = Date.now();
    const [entry] = drainPendingInput("s1");
    expect(entry!.enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.enqueuedAt).toBeLessThanOrEqual(after);
  });

  it("_pendingInputTotal counts across sessions", () => {
    enqueuePendingInput("a", "x");
    enqueuePendingInput("b", "x");
    enqueuePendingInput("b", "y");
    expect(_pendingInputTotal()).toBe(3);
  });
});

describe("isControlKillToken", () => {
  it("recognizes canonical forms", () => {
    expect(isControlKillToken("--killbot")).toBe(true);
    expect(isControlKillToken("/killbot")).toBe(true);
    expect(isControlKillToken("--kill")).toBe(true);
    expect(isControlKillToken("/kill")).toBe(true);
  });

  it("trims and lowercases", () => {
    expect(isControlKillToken("  --KILLBOT  ")).toBe(true);
    expect(isControlKillToken("/KillBot")).toBe(true);
  });

  it("rejects embedded or partial matches", () => {
    expect(isControlKillToken("please --killbot now")).toBe(false);
    expect(isControlKillToken("killbot")).toBe(false);
    expect(isControlKillToken("--killbots")).toBe(false);
    expect(isControlKillToken("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isControlKillToken(null as unknown as string)).toBe(false);
    expect(isControlKillToken(42 as unknown as string)).toBe(false);
  });
});
