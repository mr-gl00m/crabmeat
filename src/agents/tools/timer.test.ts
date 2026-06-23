import { describe, it, expect, beforeAll } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import type { ToolExecutionContext } from "./types.js";

// Register handlers once
beforeAll(() => {
  registerBuiltinTools();
});

function ctx(sessionKey = "test-session"): ToolExecutionContext {
  return { sessionKey, agentId: "default" };
}

describe("timer tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("timer")).toBe(true);
  });

  it("start + check + stop returns real elapsed time", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-elapsed");

    const start = await handler({ action: "start", label: "run" }, undefined, c);
    expect(start.content).toContain("started");

    // Wait a measurable amount
    await new Promise((r) => setTimeout(r, 50));

    const check = await handler({ action: "check", label: "run" }, undefined, c);
    expect(check.content).toContain("running");
    expect(check.content).toMatch(/\d+\.\d+s/);

    const stop = await handler({ action: "stop", label: "run" }, undefined, c);
    expect(stop.content).toContain("stopped");
    // Should show at least 0.04s (allowing small timing variance)
    const match = stop.content.match(/([\d.]+)s total/);
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeGreaterThanOrEqual(0.04);
  });

  it("rejects starting a duplicate timer", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-dup");

    await handler({ action: "start", label: "x" }, undefined, c);
    const dup = await handler({ action: "start", label: "x" }, undefined, c);
    expect(dup.isError).toBe(true);
    expect(dup.content).toContain("already running");

    // Cleanup
    await handler({ action: "stop", label: "x" }, undefined, c);
  });

  it("check on non-existent timer returns error", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-noexist");

    const res = await handler({ action: "check", label: "nope" }, undefined, c);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("No active timer");
  });

  it("stop on non-existent timer returns error", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-nostop");

    const res = await handler({ action: "stop", label: "nope" }, undefined, c);
    expect(res.isError).toBe(true);
  });

  it("list shows active timers", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-list");

    await handler({ action: "start", label: "alpha" }, undefined, c);
    await handler({ action: "start", label: "beta" }, undefined, c);

    const list = await handler({ action: "list" }, undefined, c);
    expect(list.content).toContain("alpha");
    expect(list.content).toContain("beta");
    expect(list.content).toContain("Active timers (2)");

    // Cleanup
    await handler({ action: "stop", label: "alpha" }, undefined, c);
    await handler({ action: "stop", label: "beta" }, undefined, c);
  });

  it("list returns empty message when no timers", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-empty-list");

    const list = await handler({ action: "list" }, undefined, c);
    expect(list.content).toBe("No active timers.");
  });

  it("timers are isolated between sessions", async () => {
    const handler = getToolHandler("timer");
    const c1 = ctx("session-A");
    const c2 = ctx("session-B");

    await handler({ action: "start", label: "shared" }, undefined, c1);

    // Session B should not see session A's timer
    const check = await handler({ action: "check", label: "shared" }, undefined, c2);
    expect(check.isError).toBe(true);

    // Cleanup
    await handler({ action: "stop", label: "shared" }, undefined, c1);
  });

  it("uses 'default' label when none provided", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-default-label");

    const start = await handler({ action: "start" }, undefined, c);
    expect(start.content).toContain("'default' started");

    const stop = await handler({ action: "stop" }, undefined, c);
    expect(stop.content).toContain("'default' stopped");
  });

  it("rejects invalid label characters", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-badlabel");

    const res = await handler({ action: "start", label: "../etc/passwd" }, undefined, c);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid timer label");
  });

  it("rejects unknown action", async () => {
    const handler = getToolHandler("timer");
    const c = ctx("timer-badaction");

    const res = await handler({ action: "explode" }, undefined, c);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown timer action");
  });
});
