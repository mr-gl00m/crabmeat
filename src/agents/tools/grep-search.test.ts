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
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-grep-"));
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

describe("grep_search tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("grep_search")).toBe(true);
  });

  it("finds matches across multiple files", async () => {
    write("a.ts", "const target = 1;\nconst other = 2;\n");
    write("b.ts", "// target is special\n");
    write("c.ts", "nothing here\n");

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "target" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("a.ts:1");
    expect(res.content).toContain("b.ts:1");
    expect(res.content).not.toContain("c.ts:");
  });

  it("supports regex patterns", async () => {
    write("x.txt", "foo123\nbar456\nbaz\n");
    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "[a-z]+\\d+" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("foo123");
    expect(res.content).toContain("bar456");
    expect(res.content).not.toContain("baz");
  });

  it("respects ignore_case", async () => {
    write("case.txt", "Hello\nhello\nHELLO\n");
    const handler = getToolHandler("grep_search");

    // Case-sensitive /hello/ matches only the lowercase line
    const sensitive = await handler({ pattern: "hello" });
    expect(sensitive.content).toContain("1 match");

    // Case-insensitive matches Hello, hello, HELLO
    const insensitive = await handler({ pattern: "hello", ignore_case: true });
    expect(insensitive.content).toContain("3 match");
  });

  it("filters by glob", async () => {
    write("a.ts", "target\n");
    write("a.md", "target\n");
    write("a.json", "target\n");

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "target", glob: "*.ts" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("a.ts");
    expect(res.content).not.toContain("a.md");
    expect(res.content).not.toContain("a.json");
  });

  it("returns files_only mode", async () => {
    write("x.txt", "needle\nneedle\nneedle\n");
    write("y.txt", "haystack\n");

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "needle", files_only: true });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("1 file(s) matched");
    expect(res.content).toContain("x.txt");
  });

  it("reports zero matches cleanly", async () => {
    write("x.txt", "hello\n");
    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "zzz" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("No matches");
  });

  it("skips node_modules and .git dirs", async () => {
    write("node_modules/pkg/index.js", "target\n");
    write(".git/config", "target\n");
    write("src/main.ts", "target\n");

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "target" });
    expect(res.content).toContain("src/main.ts");
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain(".git");
  });

  it("skips binary files by extension", async () => {
    write("image.png", "target\n");
    write("code.ts", "target\n");

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "target" });
    expect(res.content).toContain("code.ts");
    expect(res.content).not.toContain("image.png");
  });

  it("rejects invalid regex", async () => {
    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "[unclosed" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid regex");
  });

  it("rejects paths outside the workspace", async () => {
    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "x", path: "../escape" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Access denied");
  });

  it("searches a single file when path is a file", async () => {
    write("only.txt", "alpha\nbeta\ngamma\n");
    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "beta", path: "only.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("only.txt:2");
  });

  it("caps results at max_results", async () => {
    const lines = Array.from({ length: 50 }, () => "hit").join("\n");
    write("many.txt", lines);

    const handler = getToolHandler("grep_search");
    const res = await handler({ pattern: "hit", max_results: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("5 match");
    expect(res.content).toContain("truncated");
  });
});
