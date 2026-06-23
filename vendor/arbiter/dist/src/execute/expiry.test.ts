import { describe, it, expect } from "vitest";
import { checkExpiry } from "./expiry.js";
import type { Intent } from "../types.js";

function intentAt(parsedAt: number, consultedAt?: number): Intent {
  return {
    id: "i",
    action: "file_write",
    params: {},
    effectClass: "write",
    parsedAt,
    ...(consultedAt !== undefined ? { consultedAt } : {}),
  };
}

const W = { parseToConsultMaxMs: 60_000, consultToExecuteMaxMs: 300_000 };

describe("checkExpiry", () => {
  it("rejects intents that never had consult run", () => {
    const r = checkExpiry(intentAt(1000), 2000, W);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/consultedAt not set/);
  });

  it("rejects when parse->consult exceeds the window", () => {
    const r = checkExpiry(intentAt(0, 70_000), 80_000, W);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parse->consult/);
  });

  it("rejects when consult->execute exceeds the window", () => {
    const r = checkExpiry(intentAt(0, 1000), 400_000, W);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/consult->execute/);
  });

  it("rejects when consultedAt precedes parsedAt (clock skew / tamper)", () => {
    const r = checkExpiry(intentAt(5000, 1000), 6000, W);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/clock skew/);
  });

  it("rejects when consultedAt is in the future", () => {
    const r = checkExpiry(intentAt(0, 10_000), 5000, W);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  it("accepts a fresh, in-window intent", () => {
    expect(checkExpiry(intentAt(0, 5000), 10_000, W).ok).toBe(true);
  });
});
