import { describe, it, expect } from "vitest";
import { createToolHookRunner } from "./hooks.js";
import type { ValidatedInvocation, ToolResult } from "./types.js";
import type { Session } from "../../sessions/types.js";

function makeInvocation(): ValidatedInvocation {
  return {
    toolId: "test-tool",
    toolName: "test_tool",
    callId: "call-1",
    parameters: {},
    effectClass: "read",
  };
}

function makeSession(): Session {
  return {
    sessionKey: "sess-1",
    agentId: "agent-1",
    transcript: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeResult(content: string = "ok"): ToolResult {
  return {
    toolId: "test-tool",
    callId: "call-1",
    content,
    isError: false,
  };
}

describe("ToolHookRunner — pre-hooks", () => {
  it("returns allow when no hooks registered", async () => {
    const runner = createToolHookRunner();
    const verdict = await runner.runPreHooks(makeInvocation(), makeSession());
    expect(verdict.action).toBe("allow");
  });

  it("pre-hook returning deny prevents execution", async () => {
    const runner = createToolHookRunner();
    runner.registerPreHook("blocker", () => ({
      action: "deny",
      reason: "Not allowed",
    }));

    const verdict = await runner.runPreHooks(makeInvocation(), makeSession());
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toBe("Not allowed");
    }
  });

  it("pre-hook returning warn allows execution", async () => {
    const runner = createToolHookRunner();
    runner.registerPreHook("warner", () => ({
      action: "warn",
      message: "Careful here",
    }));

    const verdict = await runner.runPreHooks(makeInvocation(), makeSession());
    expect(verdict.action).toBe("allow");
  });

  it("first deny wins when multiple pre-hooks", async () => {
    const runner = createToolHookRunner();
    runner.registerPreHook("pass", () => ({ action: "allow" }));
    runner.registerPreHook("block", () => ({
      action: "deny",
      reason: "blocked",
    }));
    runner.registerPreHook("never-reached", () => ({
      action: "deny",
      reason: "should not get here",
    }));

    const verdict = await runner.runPreHooks(makeInvocation(), makeSession());
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toBe("blocked");
    }
  });

  it("thrown pre-hook results in denial (fail-closed)", async () => {
    const runner = createToolHookRunner();
    runner.registerPreHook("broken", () => {
      throw new Error("hook crashed");
    });

    const verdict = await runner.runPreHooks(makeInvocation(), makeSession());
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("broken");
    }
  });
});

describe("ToolHookRunner — post-hooks", () => {
  it("post-hook can modify tool result content", async () => {
    const runner = createToolHookRunner();
    runner.registerPostHook("annotate", (_inv, result) => ({
      ...result,
      content: result.content + " [annotated]",
    }));

    const result = await runner.runPostHooks(
      makeInvocation(),
      makeResult("data"),
      makeSession(),
    );
    expect(result.content).toBe("data [annotated]");
  });

  it("thrown post-hook passes result through unchanged", async () => {
    const runner = createToolHookRunner();
    runner.registerPostHook("broken", () => {
      throw new Error("hook crashed");
    });

    const original = makeResult("original data");
    const result = await runner.runPostHooks(
      makeInvocation(),
      original,
      makeSession(),
    );
    expect(result.content).toBe("original data");
  });

  it("post-hooks chain — each receives previous output", async () => {
    const runner = createToolHookRunner();
    runner.registerPostHook("step1", (_inv, result) => ({
      ...result,
      content: result.content + "-A",
    }));
    runner.registerPostHook("step2", (_inv, result) => ({
      ...result,
      content: result.content + "-B",
    }));

    const result = await runner.runPostHooks(
      makeInvocation(),
      makeResult("start"),
      makeSession(),
    );
    expect(result.content).toBe("start-A-B");
  });
});

describe("ToolHookRunner — registration", () => {
  it("register and remove hooks", () => {
    const runner = createToolHookRunner();
    runner.registerPreHook("h1", () => ({ action: "allow" }));
    expect(runner.preHookCount).toBe(1);

    runner.removePreHook("h1");
    expect(runner.preHookCount).toBe(0);
  });

  it("counts reflect registration state", () => {
    const runner = createToolHookRunner();
    expect(runner.preHookCount).toBe(0);
    expect(runner.postHookCount).toBe(0);

    runner.registerPreHook("p1", () => ({ action: "allow" }));
    runner.registerPostHook("q1", (_i, r) => r);
    runner.registerPostHook("q2", (_i, r) => r);

    expect(runner.preHookCount).toBe(1);
    expect(runner.postHookCount).toBe(2);
  });
});
