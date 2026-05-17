import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, nextCronMatch, validateCron } from "./cron.js";

describe("parseCron", () => {
  it("parses simple wildcard expression", () => {
    const cron = parseCron("* * * * *");
    expect(cron.minute.values.size).toBe(60);
    expect(cron.hour.values.size).toBe(24);
    expect(cron.dayOfMonth.values.size).toBe(31);
    expect(cron.month.values.size).toBe(12);
    expect(cron.dayOfWeek.values.size).toBe(8); // 0-7
  });

  it("parses exact values", () => {
    const cron = parseCron("30 9 1 1 0");
    expect(cron.minute.values).toEqual(new Set([30]));
    expect(cron.hour.values).toEqual(new Set([9]));
    expect(cron.dayOfMonth.values).toEqual(new Set([1]));
    expect(cron.month.values).toEqual(new Set([1]));
    expect(cron.dayOfWeek.values).toEqual(new Set([0]));
  });

  it("parses lists", () => {
    const cron = parseCron("0,30 9,17 * * 1,3,5");
    expect(cron.minute.values).toEqual(new Set([0, 30]));
    expect(cron.hour.values).toEqual(new Set([9, 17]));
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 3, 5]));
  });

  it("parses ranges", () => {
    const cron = parseCron("0 9-17 * * 1-5");
    expect(cron.hour.values).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("parses steps", () => {
    const cron = parseCron("*/15 * * * *");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
  });

  it("parses range with step", () => {
    const cron = parseCron("0-30/10 * * * *");
    expect(cron.minute.values).toEqual(new Set([0, 10, 20, 30]));
  });

  it("parses @daily shortcut", () => {
    const cron = parseCron("@daily");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values).toEqual(new Set([0]));
    expect(cron.dayOfMonth.values.size).toBe(31);
  });

  it("parses @hourly shortcut", () => {
    const cron = parseCron("@hourly");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values.size).toBe(24);
  });

  it("parses @weekly shortcut", () => {
    const cron = parseCron("@weekly");
    expect(cron.dayOfWeek.values).toEqual(new Set([0]));
  });

  it("throws on invalid field count", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields");
  });

  it("throws on out-of-range value", () => {
    expect(() => parseCron("60 * * * *")).toThrow("out of range");
  });
});

describe("cronMatches", () => {
  it("matches every-minute pattern", () => {
    const cron = parseCron("* * * * *");
    expect(cronMatches(cron, new Date("2026-04-02T10:30:00"))).toBe(true);
  });

  it("matches exact time", () => {
    const cron = parseCron("30 9 * * *");
    expect(cronMatches(cron, new Date("2026-04-02T09:30:00"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-04-02T09:31:00"))).toBe(false);
    expect(cronMatches(cron, new Date("2026-04-02T10:30:00"))).toBe(false);
  });

  it("matches day of week", () => {
    // 2026-04-06 is a Monday (day 1)
    const cron = parseCron("0 9 * * 1");
    expect(cronMatches(cron, new Date("2026-04-06T09:00:00"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-04-07T09:00:00"))).toBe(false); // Tuesday
  });

  it("treats 7 as Sunday", () => {
    const cron = parseCron("0 0 * * 7");
    // 2026-04-05 is a Sunday
    expect(cronMatches(cron, new Date("2026-04-05T00:00:00"))).toBe(true);
  });

  it("matches specific month", () => {
    const cron = parseCron("0 0 1 12 *");
    expect(cronMatches(cron, new Date("2026-12-01T00:00:00"))).toBe(true);
    expect(cronMatches(cron, new Date("2026-11-01T00:00:00"))).toBe(false);
  });
});

describe("nextCronMatch", () => {
  it("finds next minute for * * * * *", () => {
    const cron = parseCron("* * * * *");
    const after = new Date("2026-04-02T10:30:00");
    const next = nextCronMatch(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(31);
  });

  it("finds next daily 9am", () => {
    const cron = parseCron("0 9 * * *");
    const after = new Date("2026-04-02T10:00:00"); // After 9am
    const next = nextCronMatch(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(3); // Next day
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  it("finds next occurrence before current time", () => {
    const cron = parseCron("0 9 * * *");
    const after = new Date("2026-04-02T08:00:00"); // Before 9am
    const next = nextCronMatch(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(2); // Same day
    expect(next!.getHours()).toBe(9);
  });
});

describe("validateCron", () => {
  it("returns null for valid expressions", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
    expect(validateCron("*/15 * * * *")).toBeNull();
    expect(validateCron("@daily")).toBeNull();
  });

  it("returns error message for invalid expressions", () => {
    expect(validateCron("invalid")).toContain("expected 5 fields");
    expect(validateCron("60 * * * *")).toContain("out of range");
  });
});
