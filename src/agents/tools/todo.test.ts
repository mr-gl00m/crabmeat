import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import {
  _resetTodoState,
  _peekTodos,
  _todoSessionCount,
  MAX_TODO_SESSIONS,
} from "./todo.js";
import type { ToolExecutionContext } from "./types.js";

beforeAll(() => {
  registerBuiltinTools();
});

beforeEach(() => {
  _resetTodoState();
});

const ctx = (sessionKey = "s1"): ToolExecutionContext => ({
  sessionKey,
  agentId: "default",
});

describe("todo_write tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("todo_write")).toBe(true);
  });

  it("requires an action", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({}, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'action' is required");
  });

  it("rejects unknown action", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({ action: "nuke" }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("unknown action");
  });

  it("list is empty by default", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({ action: "list" }, undefined, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("No todos");
  });

  it("set creates todos from string array with auto ids", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      { action: "set", todos: ["write tests", "run vitest", "commit"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("3 todo(s)");

    const stored = _peekTodos("s1");
    expect(stored).toHaveLength(3);
    expect(stored[0]!.id).toBe("td-01");
    expect(stored[0]!.text).toBe("write tests");
    expect(stored[0]!.status).toBe("pending");
    expect(stored[2]!.id).toBe("td-03");
  });

  it("set accepts object items with id and status", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      {
        action: "set",
        todos: [
          { id: "plan", text: "draft plan", status: "completed" },
          { id: "impl", text: "write code", status: "in_progress" },
          { id: "ship", text: "deploy" },
        ],
      },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const stored = _peekTodos("s1");
    expect(stored[0]!.id).toBe("plan");
    expect(stored[0]!.status).toBe("completed");
    expect(stored[1]!.status).toBe("in_progress");
    expect(stored[2]!.status).toBe("pending");
  });

  it("set rejects non-array todos", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({ action: "set", todos: "not array" }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must be an array");
  });

  it("set rejects too many todos", async () => {
    const handler = getToolHandler("todo_write");
    const many = Array.from({ length: 51 }, (_, i) => `item ${i}`);
    const res = await handler({ action: "set", todos: many }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too many");
  });

  it("set rejects empty item text", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      { action: "set", todos: ["good", "   "] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("item 1");
    expect(res.content).toContain("empty");
  });

  it("set rejects overlong text", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      { action: "set", todos: ["x".repeat(501)] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too long");
  });

  it("set rejects duplicate ids", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      {
        action: "set",
        todos: [
          { id: "a", text: "first" },
          { id: "a", text: "second" },
        ],
      },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("duplicate id");
  });

  it("set rejects invalid status on item", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      {
        action: "set",
        todos: [{ id: "a", text: "x", status: "broken" }],
      },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("invalid status");
  });

  it("set rejects non-object non-string item", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler(
      { action: "set", todos: [42] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must be a string or object");
  });

  it("update changes status by id", async () => {
    const handler = getToolHandler("todo_write");
    await handler(
      { action: "set", todos: ["one", "two", "three"] },
      undefined,
      ctx(),
    );
    const res = await handler(
      { action: "update", id: "td-02", status: "completed" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const stored = _peekTodos("s1");
    expect(stored[1]!.status).toBe("completed");
    expect(stored[0]!.status).toBe("pending");
    expect(stored[2]!.status).toBe("pending");
  });

  it("update changes text by id", async () => {
    const handler = getToolHandler("todo_write");
    await handler(
      { action: "set", todos: [{ id: "a", text: "old text" }] },
      undefined,
      ctx(),
    );
    const res = await handler(
      { action: "update", id: "a", text: "new text" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(_peekTodos("s1")[0]!.text).toBe("new text");
  });

  it("update requires id", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({ action: "update", status: "completed" }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'id' is required");
  });

  it("update rejects unknown id", async () => {
    const handler = getToolHandler("todo_write");
    await handler({ action: "set", todos: ["a"] }, undefined, ctx());
    const res = await handler(
      { action: "update", id: "missing", status: "completed" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no todo with id");
  });

  it("update rejects invalid status", async () => {
    const handler = getToolHandler("todo_write");
    await handler({ action: "set", todos: ["a"] }, undefined, ctx());
    const res = await handler(
      { action: "update", id: "td-01", status: "weird" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("invalid status");
  });

  it("update with no changes is an error", async () => {
    const handler = getToolHandler("todo_write");
    await handler({ action: "set", todos: ["a"] }, undefined, ctx());
    const res = await handler({ action: "update", id: "td-01" }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no effect");
  });

  it("clear wipes the list", async () => {
    const handler = getToolHandler("todo_write");
    await handler({ action: "set", todos: ["a", "b"] }, undefined, ctx());
    const res = await handler({ action: "clear" }, undefined, ctx());
    expect(res.isError).toBeFalsy();
    expect(_peekTodos("s1")).toHaveLength(0);
  });

  it("sessions are isolated", async () => {
    const handler = getToolHandler("todo_write");
    await handler({ action: "set", todos: ["alpha"] }, undefined, ctx("sA"));
    await handler({ action: "set", todos: ["beta", "gamma"] }, undefined, ctx("sB"));

    expect(_peekTodos("sA")).toHaveLength(1);
    expect(_peekTodos("sA")[0]!.text).toBe("alpha");
    expect(_peekTodos("sB")).toHaveLength(2);

    // Listing on sB must not see sA's todos
    const resB = await handler({ action: "list" }, undefined, ctx("sB"));
    expect(resB.content).toContain("beta");
    expect(resB.content).not.toContain("alpha");
  });

  it("LRU-evicts oldest sessions past the cap", async () => {
    const handler = getToolHandler("todo_write");
    // Fill past the cap
    for (let i = 0; i < MAX_TODO_SESSIONS + 5; i++) {
      await handler(
        { action: "set", todos: ["x"] },
        undefined,
        ctx(`session-${i}`),
      );
    }
    expect(_todoSessionCount()).toBeLessThanOrEqual(MAX_TODO_SESSIONS);
    // Earliest sessions should have been evicted
    expect(_peekTodos("session-0")).toHaveLength(0);
    // Recent session should still be there
    expect(_peekTodos(`session-${MAX_TODO_SESSIONS + 4}`)).toHaveLength(1);
  });

  it("falls back to _global session when no context provided", async () => {
    const handler = getToolHandler("todo_write");
    const res = await handler({ action: "set", todos: ["alone"] });
    expect(res.isError).toBeFalsy();
    expect(_peekTodos("_global")).toHaveLength(1);
  });
});
