/**
 * Tests for the tasks_manage tool handler and buildTasksPromptSection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// We need to set the workspace root before importing agent-data
import { setWorkspaceRoot } from "./builtins.js";

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `crabmeat-tasks-test-${randomUUID().slice(0, 8)}`);
  await mkdir(join(testDir, ".crabmeat"), { recursive: true });
  setWorkspaceRoot(testDir);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// Dynamic import so workspace root is set first
async function getHandlers() {
  // Re-import to pick up the workspace root
  const mod = await import("./agent-data.js");
  return mod;
}

async function callTasksManage(params: Record<string, unknown>) {
  // Use the handler registry
  const { getToolHandler } = await import("./handlers.js");
  const { registerAgentDataTools } = await import("./agent-data.js");

  // Register if not already registered
  try { registerAgentDataTools(); } catch { /* already registered */ }

  const handler = getToolHandler("tasks_manage");
  return handler(params);
}

async function readTasksFile(): Promise<unknown> {
  const raw = await readFile(join(testDir, ".crabmeat", "tasks.json"), "utf-8");
  return JSON.parse(raw);
}

describe("tasks_manage handler", () => {
  it("requires an action parameter", async () => {
    const result = await callTasksManage({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action");
  });

  it("rejects unknown actions", async () => {
    const result = await callTasksManage({ action: "explode" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown action");
  });

  describe("create_list", () => {
    it("creates an empty list", async () => {
      const result = await callTasksManage({ action: "create_list", title: "My Tasks" });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Created list");
      expect(result.content).toContain("My Tasks");
      expect(result.content).toContain("0 item(s)");
    });

    it("creates a list with pre-populated items", async () => {
      const result = await callTasksManage({
        action: "create_list",
        title: "Research",
        items: ["Search Google", "Read articles", "Write summary"],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("3 item(s)");

      const data = await readTasksFile() as { lists: Array<{ items: unknown[] }> };
      expect(data.lists[0].items).toHaveLength(3);
    });

    it("requires a title", async () => {
      const result = await callTasksManage({ action: "create_list" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("title");
    });

    it("rejects duplicate list IDs", async () => {
      await callTasksManage({ action: "create_list", title: "First", id: "dup" });
      const result = await callTasksManage({ action: "create_list", title: "Second", id: "dup" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("already exists");
    });
  });

  describe("add_item", () => {
    it("adds an item to an existing list", async () => {
      await callTasksManage({ action: "create_list", title: "Work", id: "work" });
      const result = await callTasksManage({ action: "add_item", listId: "work", text: "Do the thing" });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Do the thing");
    });

    it("requires listId and text", async () => {
      const r1 = await callTasksManage({ action: "add_item", text: "no list" });
      expect(r1.isError).toBe(true);
      const r2 = await callTasksManage({ action: "add_item", listId: "x" });
      expect(r2.isError).toBe(true);
    });

    it("errors on nonexistent list", async () => {
      const result = await callTasksManage({ action: "add_item", listId: "nope", text: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  describe("check / uncheck", () => {
    it("checks off an item and reports remaining", async () => {
      await callTasksManage({
        action: "create_list", title: "Checklist", id: "cl",
        items: ["Item A", "Item B"],
      });

      const data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string }> }> };
      const itemId = data.lists[0].items[0].id;

      const result = await callTasksManage({ action: "check", listId: "cl", itemId });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("[x]");
      expect(result.content).toContain("1 remaining");
    });

    it("unchecks a previously checked item", async () => {
      await callTasksManage({ action: "create_list", title: "Test", id: "t", items: ["Do it"] });
      const data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string }> }> };
      const itemId = data.lists[0].items[0].id;

      await callTasksManage({ action: "check", listId: "t", itemId });
      const result = await callTasksManage({ action: "uncheck", listId: "t", itemId });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("[ ]");
    });

    it("errors on nonexistent item", async () => {
      await callTasksManage({ action: "create_list", title: "X", id: "x" });
      const result = await callTasksManage({ action: "check", listId: "x", itemId: "nope" });
      expect(result.isError).toBe(true);
    });
  });

  describe("remove_item", () => {
    it("removes an item from a list", async () => {
      await callTasksManage({ action: "create_list", title: "R", id: "r", items: ["Keep", "Remove"] });
      const data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string; text: string }> }> };
      const removeId = data.lists[0].items[1].id;

      const result = await callTasksManage({ action: "remove_item", listId: "r", itemId: removeId });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Removed");

      const after = await readTasksFile() as { lists: Array<{ items: unknown[] }> };
      expect(after.lists[0].items).toHaveLength(1);
    });
  });

  describe("delete_list", () => {
    it("deletes a list entirely", async () => {
      await callTasksManage({ action: "create_list", title: "Gone", id: "gone" });
      const result = await callTasksManage({ action: "delete_list", listId: "gone" });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Deleted");
    });

    it("errors on nonexistent list", async () => {
      const result = await callTasksManage({ action: "delete_list", listId: "nope" });
      expect(result.isError).toBe(true);
    });
  });

  describe("list", () => {
    it("shows all lists when no listId given", async () => {
      await callTasksManage({ action: "create_list", title: "Alpha", id: "a", items: ["One"] });
      await callTasksManage({ action: "create_list", title: "Beta", id: "b", items: ["Two", "Three"] });

      const result = await callTasksManage({ action: "list" });
      expect(result.content).toContain("Alpha");
      expect(result.content).toContain("Beta");
      expect(result.content).toContain("0/1 done");
      expect(result.content).toContain("0/2 done");
    });

    it("shows a specific list when listId given", async () => {
      await callTasksManage({ action: "create_list", title: "Specific", id: "s", items: ["X", "Y"] });
      const result = await callTasksManage({ action: "list", listId: "s" });
      expect(result.content).toContain("Specific");
      expect(result.content).toContain("X");
      expect(result.content).toContain("Y");
    });

    it("reports when no lists exist", async () => {
      const result = await callTasksManage({ action: "list" });
      expect(result.content).toContain("No task lists");
    });
  });
});

describe("buildTasksPromptSection", () => {
  it("returns empty when no tasks file exists", async () => {
    const { buildTasksPromptSection } = await getHandlers();
    const result = await buildTasksPromptSection(testDir);
    expect(result).toBe("");
  });

  it("returns empty when all tasks are complete", async () => {
    await callTasksManage({ action: "create_list", title: "Done", id: "d", items: ["A"] });
    const data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string }> }> };
    await callTasksManage({ action: "check", listId: "d", itemId: data.lists[0].items[0].id });

    const { buildTasksPromptSection } = await getHandlers();
    const result = await buildTasksPromptSection(testDir);
    expect(result).toBe("");
  });

  it("includes active lists with incomplete items", async () => {
    await callTasksManage({
      action: "create_list", title: "Pokemon Report", id: "pr",
      items: ["Search news", "Browse sites", "Write report"],
    });

    const { buildTasksPromptSection } = await getHandlers();
    const result = await buildTasksPromptSection(testDir);
    expect(result).toContain("[ACTIVE TASKS]");
    expect(result).toContain("Pokemon Report");
    expect(result).toContain("Search news");
    expect(result).toContain("tasks_manage");
  });

  it("excludes fully-complete lists but includes partially-complete ones", async () => {
    // Create a complete list
    await callTasksManage({ action: "create_list", title: "AllDone", id: "ad", items: ["X"] });
    let data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string }> }> };
    await callTasksManage({ action: "check", listId: "ad", itemId: data.lists[0].items[0].id });

    // Create a partial list
    await callTasksManage({ action: "create_list", title: "Partial", id: "pa", items: ["A", "B"] });
    data = await readTasksFile() as { lists: Array<{ items: Array<{ id: string }> }> };
    const partialList = data.lists.find((l: { id: string }) => l.id === "pa")!;
    await callTasksManage({ action: "check", listId: "pa", itemId: partialList.items[0].id });

    const { buildTasksPromptSection } = await getHandlers();
    const result = await buildTasksPromptSection(testDir);
    expect(result).toContain("Partial");
    expect(result).not.toContain("AllDone");
  });
});
