// Regression test for BH-2026-05-10-003 + BH-2026-05-10-006 (bug-hunt
// 2026-05-10). Both findings share a single root cause in the cron step
// branch: parseField did not validate that rangeMin/rangeMax were finite
// or that rangeMin <= rangeMax before entering the for-loop. Inverted
// ranges (`30-5/2`) and NaN bases (`-5/15`) silently produced empty
// value sets that parsed cleanly and never fired.
//
// Fix: after parsing rangeMin/rangeMax in the step branch, throw on
// non-finite or inverted bounds. Mirrors the non-step-range path which
// throws `Invalid range` on `start > end`.
//
// Note: the second `it` per finding ("if accepted...") uses try/catch
// so the test still passes when parseCron correctly throws; the throw
// is the desired post-fix behavior.
import { describe, it, expect } from "vitest";
import {
  parseCron,
  nextCronMatch,
  validateCron,
} from "../src/scheduler/cron.js";

describe("BH-2026-05-10-003: parseField step with inverted range", () => {
  it("rejects '30-5/2' (start > end) like the non-step range path does", () => {
    expect(() => parseCron("30-5 * * * *")).toThrow(/Invalid range/);
    expect(
      () => parseCron("30-5/2 * * * *"),
      "parseCron silently accepts '30-5/2' and emits an empty value set",
    ).toThrow();
  });

  it("'30-5/2' produces an unfireable schedule when accepted", () => {
    let cron;
    try {
      cron = parseCron("30-5/2 * * * *");
    } catch {
      return; // throwing is the post-fix correct behavior
    }
    expect(
      cron.minute.values.size,
      `Inverted range step produced ${cron.minute.values.size} values; ` +
        "an unfireable cron schedule should be rejected at parse time, " +
        "not silently produce an empty value set.",
    ).toBeGreaterThan(0);
    const next = nextCronMatch(cron, new Date("2026-01-01T00:00:00Z"));
    expect(next).not.toBeNull();
  });

  it("validateCron flags '30-5/2' as invalid", () => {
    const err = validateCron("30-5/2 * * * *");
    expect(
      err,
      "validateCron returned null (valid) for an unfireable expression",
    ).not.toBeNull();
  });
});

describe("BH-2026-05-10-006: parseField step with malformed base", () => {
  it("rejects '-5/15' rather than producing an empty value set", () => {
    expect(
      () => parseCron("-5/15 * * * *"),
      "parseCron silently accepts '-5/15' and yields zero matchable minutes",
    ).toThrow();
  });

  it("if accepted, the schedule must have at least one matching minute", () => {
    let cron;
    try {
      cron = parseCron("-5/15 * * * *");
    } catch {
      return;
    }
    expect(cron.minute.values.size).toBeGreaterThan(0);
  });
});
