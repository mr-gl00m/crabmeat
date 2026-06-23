import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleHookRegistry } from "./registry.js";
import type { HookAuditSink } from "./types.js";
import { hooksConfigSchema } from "./config.js";

interface CapturedAudit {
  sessionId: string;
  event: string;
  hookId: string;
  outcome: string;
  durationMs: number;
  errorSummary?: string;
}

function makeAuditSink(bucket: CapturedAudit[]): HookAuditSink {
  return {
    recordHookInvocation(e) {
      bucket.push({
        sessionId: e.sessionId,
        event: e.event,
        hookId: e.hookId,
        outcome: e.outcome,
        durationMs: e.durationMs,
        errorSummary: e.errorSummary,
      });
    },
  };
}

describe("lifecycle hook registry", () => {
  let workspaceRoot: string;
  let auditBucket: CapturedAudit[];

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "crabmeat-hooks-test-"));
    auditBucket = [];
  });

  async function writeFnHook(name: string, body: string): Promise<string> {
    const p = join(workspaceRoot, `${name}.mjs`);
    await writeFile(p, body, "utf-8");
    return p;
  }

  it("returns an empty-registry no-op when disableAll is set", async () => {
    const config = hooksConfigSchema.parse({ disableAll: true, handlers: {} });
    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    expect(registry.disableAll).toBe(true);
    expect(registry.handlerCount("after_tool")).toBe(0);

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 10,
    });
    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(0);
  });

  it("dispatches a function hook and records audit entry", async () => {
    await writeFnHook(
      "ok-hook",
      `export default function (ctx) { return { outcome: "ok" }; }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [{ type: "function", id: "ok", module: "./ok-hook.mjs" }],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    expect(registry.handlerCount("after_tool")).toBe(1);

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 10,
    });

    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.hookId).toBe("ok");
    expect(auditBucket[0]!.outcome).toBe("ok");
    expect(auditBucket[0]!.sessionId).toBe("s1");
  });

  it("blocks on a blockable event when a handler returns blocked", async () => {
    await writeFnHook(
      "block-hook",
      `export default function (ctx) { return { outcome: "blocked", reason: "test-block" }; }`,
    );
    await writeFnHook(
      "never-runs",
      `export default function (ctx) { throw new Error("this should NEVER run"); }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        before_tool: [
          { type: "function", id: "blocker", module: "./block-hook.mjs" },
          { type: "function", id: "after-blocker", module: "./never-runs.mjs" },
        ],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const result = await registry.fire("before_tool", {
      sessionId: "s1",
      toolName: "shell",
      toolId: "shell",
      effectClass: "exec",
      callId: "c",
      arguments: { cmd: "ls" },
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("test-block");
      expect(result.blockedByHookId).toBe("blocker");
    }

    // Only the first handler should have run; the second is short-circuited.
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.outcome).toBe("blocked");
  });

  it("coerces 'blocked' on a non-blockable event to soft_error", async () => {
    await writeFnHook(
      "misuse-block",
      `export default function (ctx) { return { outcome: "blocked", reason: "nope" }; }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [{ type: "function", id: "misuse", module: "./misuse-block.mjs" }],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 10,
    });

    expect(result.blocked).toBe(false);
    // Two audit entries: the original "blocked" record + the misuse coercion
    expect(auditBucket.length).toBeGreaterThanOrEqual(1);
    const coercion = auditBucket.find((e) => e.errorSummary?.includes("misuse"));
    expect(coercion).toBeDefined();
  });

  it("soft-fails on handler exception, continues to next handler", async () => {
    await writeFnHook(
      "throwing",
      `export default function (ctx) { throw new Error("boom"); }`,
    );
    await writeFnHook(
      "survivor",
      `export default function (ctx) { return { outcome: "ok" }; }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [
          { type: "function", id: "bad", module: "./throwing.mjs" },
          { type: "function", id: "good", module: "./survivor.mjs" },
        ],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 10,
    });

    // After_tool is non-blockable; the turn continues regardless
    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(2);
    expect(auditBucket[0]!.outcome).toBe("soft_error");
    expect(auditBucket[0]!.errorSummary).toContain("boom");
    expect(auditBucket[1]!.outcome).toBe("ok");
  });

  it("enforces handler timeout, converts to soft_error", async () => {
    await writeFnHook(
      "slow",
      `export default function (ctx) {
         return new Promise((resolve) => {
           setTimeout(() => resolve({ outcome: "ok" }), 5000);
         });
       }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [
          { type: "function", id: "slow", module: "./slow.mjs", timeout: 200 },
        ],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const start = Date.now();
    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 0,
    });
    const elapsed = Date.now() - start;

    expect(result.blocked).toBe(false);
    expect(elapsed).toBeLessThan(2000); // did not wait 5s
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.outcome).toBe("soft_error");
    expect(auditBucket[0]!.errorSummary).toContain("timed out");
  });

  it("skips a function hook whose module fails to load, still loads the rest", async () => {
    await writeFnHook(
      "good",
      `export default function (ctx) { return { outcome: "ok" }; }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [
          { type: "function", id: "missing", module: "./does-not-exist.mjs" },
          { type: "function", id: "good", module: "./good.mjs" },
        ],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    expect(registry.handlerCount("after_tool")).toBe(1);

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 0,
    });

    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.hookId).toBe("good");
  });

  it("runs a command hook that returns ok via empty stdout", async () => {
    // Cross-platform "true" using node itself. Works on Windows where /usr/bin/true doesn't exist.
    const runCmd = `node -e "process.exit(0)"`;

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [{ type: "command", id: "noop", run: runCmd, timeout: 5000 }],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 0,
    });

    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.outcome).toBe("ok");
    expect(auditBucket[0]!.hookId).toBe("noop");
  });

  it("converts non-zero exit from a command hook into soft_error", async () => {
    const runCmd = `node -e "process.exit(7)"`;

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [{ type: "command", id: "fail", run: runCmd, timeout: 5000 }],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    const result = await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 0,
    });

    expect(result.blocked).toBe(false);
    expect(auditBucket).toHaveLength(1);
    expect(auditBucket[0]!.outcome).toBe("soft_error");
    expect(auditBucket[0]!.errorSummary).toContain("exit 7");
  });

  it("runs handlers in declared order", async () => {
    // Order is verified via audit sink arrival order.
    await writeFnHook(
      "ok1",
      `export default function () { return { outcome: "ok" }; }`,
    );
    await writeFnHook(
      "ok2",
      `export default function () { return { outcome: "ok" }; }`,
    );
    await writeFnHook(
      "ok3",
      `export default function () { return { outcome: "ok" }; }`,
    );

    const config = hooksConfigSchema.parse({
      handlers: {
        after_tool: [
          { type: "function", id: "first", module: "./ok1.mjs" },
          { type: "function", id: "second", module: "./ok2.mjs" },
          { type: "function", id: "third", module: "./ok3.mjs" },
        ],
      },
    });

    const registry = await createLifecycleHookRegistry({
      config,
      workspaceRoot,
      audit: makeAuditSink(auditBucket),
    });

    await registry.fire("after_tool", {
      sessionId: "s1",
      toolName: "t",
      toolId: "t",
      effectClass: "read",
      callId: "c",
      arguments: {},
      resultIsError: false,
      resultSummary: "",
      durationMs: 0,
    });

    expect(auditBucket.map((e) => e.hookId)).toEqual(["first", "second", "third"]);
  });

  afterEach(async () => {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
});
