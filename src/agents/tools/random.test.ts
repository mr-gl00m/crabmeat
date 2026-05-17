import { describe, it, expect, beforeAll } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";

beforeAll(() => {
  registerBuiltinTools();
});

/** Extract the bold number from conversational output like "...is **42**." */
function extractBoldNumber(text: string): number {
  const match = /\*\*(\d+)\*\*/.exec(text);
  return match ? parseInt(match[1], 10) : NaN;
}

describe("random tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("random")).toBe(true);
  });

  it("generates integer in range (default 1-10)", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "integer" });
    expect(res.content).toContain("random number between 1 and 10");
    const val = extractBoldNumber(res.content);
    expect(val).toBeGreaterThanOrEqual(1);
    expect(val).toBeLessThanOrEqual(10);
  });

  it("generates integer with custom range", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "integer", min: 100, max: 200 });
    expect(res.content).toContain("between 100 and 200");
    const val = extractBoldNumber(res.content);
    expect(val).toBeGreaterThanOrEqual(100);
    expect(val).toBeLessThanOrEqual(200);
  });

  it("rejects min >= max", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "integer", min: 10, max: 5 });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("min must be less than max");
  });

  it("generates float in [0, 1)", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "float" });
    const match = /\*\*([\d.]+(?:e[+-]?\d+)?)\*\*/.exec(res.content);
    expect(match).not.toBeNull();
    const val = parseFloat(match![1]);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(1);
  });

  it("generates a valid UUID", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "uuid" });
    expect(res.content).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("picks from options array", async () => {
    const handler = getToolHandler("random");
    const options = ["red", "green", "blue"];
    const res = await handler({ mode: "choice", options });
    expect(res.content).toContain("picked");
    const picked = options.some((o) => res.content.includes(`**${o}**`));
    expect(picked).toBe(true);
  });

  it("rejects empty options array", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "choice", options: [] });
    expect(res.isError).toBe(true);
  });

  it("rolls a single die (default d6)", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "dice" });
    expect(res.content).toContain("rolled");
    const val = extractBoldNumber(res.content);
    expect(val).toBeGreaterThanOrEqual(1);
    expect(val).toBeLessThanOrEqual(6);
  });

  it("rolls multiple dice and shows total", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "dice", count: 3, sides: 6 });
    expect(res.content).toContain("rolled");
    expect(res.content).toContain("total of");
  });

  it("rejects invalid mode", async () => {
    const handler = getToolHandler("random");
    const res = await handler({ mode: "quantum" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown mode");
  });

  it("defaults to integer mode when mode omitted", async () => {
    const handler = getToolHandler("random");
    const res = await handler({});
    const val = extractBoldNumber(res.content);
    expect(val).toBeGreaterThanOrEqual(1);
    expect(val).toBeLessThanOrEqual(10);
  });

  it("produces varied results (not always 7)", async () => {
    const handler = getToolHandler("random");
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const res = await handler({ mode: "integer", min: 1, max: 10 });
      results.add(extractBoldNumber(res.content));
    }
    // With true randomness, 20 draws from 1-10 should produce at least 3 distinct values
    expect(results.size).toBeGreaterThanOrEqual(3);
  });
});
