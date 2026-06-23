import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinTools, setWorkspaceRoot } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";

let workspace: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-searchfiles-"));
  setWorkspaceRoot(workspace);
  registerBuiltinTools();
});

afterAll(() => {
  setWorkspaceRoot(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

function write(rel: string, content: string): void {
  const full = join(workspace, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("search_files tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("search_files")).toBe(true);
  });

  it("requires a query", async () => {
    const handler = getToolHandler("search_files");
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("query is required");

    const blank = await handler({ query: "   " });
    expect(blank.isError).toBe(true);
  });

  it("finds files by name", async () => {
    write("tax_letter_2024.txt", "nothing relevant\n");
    write("unrelated.txt", "nothing relevant\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "tax letter" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("tax_letter_2024.txt");
    expect(res.content).not.toContain("unrelated.txt");
  });

  it("finds files by content when all tokens share a line", async () => {
    write("notes.txt", "the tax letter arrived today\n");
    write("partial.txt", "tax season\nletter to grandma\n");
    write("none.txt", "completely different\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "tax letter" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("notes.txt:1");
    expect(res.content).toContain("the tax letter arrived today");
    // tokens on separate lines do not count as a content match
    expect(res.content).not.toContain("partial.txt:");
    expect(res.content).not.toContain("none.txt");
  });

  it("ranks exact name match above content-only match", async () => {
    write("report.md", "something else entirely\n");
    write("journal.txt", "I finished the report yesterday\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "report" });
    expect(res.isError).toBeFalsy();
    const reportIdx = res.content.indexOf("report.md");
    const journalIdx = res.content.indexOf("journal.txt");
    expect(reportIdx).toBeGreaterThan(-1);
    expect(journalIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeLessThan(journalIdx);
  });

  it("boosts files matching by both name and content", async () => {
    write("recipes.txt", "chocolate cake recipes\n");
    write("recipes_old.txt", "nothing matching here\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "recipes" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("[name+content]");
    const bothIdx = res.content.indexOf("recipes.txt");
    const nameOnlyIdx = res.content.indexOf("recipes_old.txt");
    expect(bothIdx).toBeLessThan(nameOnlyIdx);
  });

  it("is case-insensitive", async () => {
    write("Budget.XLSX.txt", "MONTHLY BUDGET NUMBERS\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "budget" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Budget.XLSX.txt");
  });

  it("treats the query as literal text, not regex", async () => {
    write("math.txt", "the formula a+b (squared) is here\n");

    const handler = getToolHandler("search_files");
    // would be an invalid/greedy regex if interpreted as one
    const res = await handler({ query: "a+b (squared)" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("math.txt:1");
  });

  it("searches subdirectories but skips hidden and dependency dirs", async () => {
    write("docs/guide.txt", "install guide\n");
    write("node_modules/pkg/guide.txt", "install guide\n");
    write(".hidden/guide.txt", "install guide\n");

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "guide" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("docs/guide.txt");
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain(".hidden");
  });

  it("respects max_results and reports truncation", async () => {
    for (let i = 0; i < 10; i++) {
      write(`memo_${i}.txt`, "memo content\n");
    }

    const handler = getToolHandler("search_files");
    const res = await handler({ query: "memo", max_results: 3 });
    expect(res.isError).toBeFalsy();
    const outputs = res.outputs as { count: number; truncated: boolean };
    expect(outputs.count).toBe(3);
    expect(outputs.truncated).toBe(true);
    expect(res.content).toContain("showing top 3");
  });

  it("rejects paths outside the workspace", async () => {
    const handler = getToolHandler("search_files");
    const res = await handler({ query: "anything", path: "../.." });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Access denied");
  });

  it("reports zero matches honestly", async () => {
    write("a.txt", "hello\n");
    const handler = getToolHandler("search_files");
    const res = await handler({ query: "zebra unicorn" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("No files matched");
    const outputs = res.outputs as { count: number };
    expect(outputs.count).toBe(0);
  });

  it("searches a single file when path points at one", async () => {
    write("single.txt", "needle in here\n");
    const handler = getToolHandler("search_files");
    const res = await handler({ query: "needle", path: "single.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("single.txt:1");
  });
});
