import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap infra/fs so RT-2026-05-01-003 can verify that file_edit routes
// the replacement write through writeFileAtomic instead of the raw
// fs.writeFile that left the target truncatable on a crash.
vi.mock("../../infra/fs.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/fs.js")>(
    "../../infra/fs.js",
  );
  return {
    ...actual,
    writeFileAtomic: vi.fn(actual.writeFileAtomic),
  };
});

import { registerBuiltinTools, setWorkspaceRoot } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import { writeFileAtomic } from "../../infra/fs.js";

const writeFileAtomicMock = vi.mocked(writeFileAtomic);

let workspace: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-file-edit-"));
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
  writeFileAtomicMock.mockClear();
});

function write(rel: string, content: string): void {
  writeFileSync(join(workspace, rel), content, "utf-8");
}

function read(rel: string): string {
  return readFileSync(join(workspace, rel), "utf-8");
}

describe("file_edit tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("file_edit")).toBe(true);
  });

  it("replaces a unique string", async () => {
    write("a.txt", "hello world\nbye world\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "a.txt",
      old_string: "hello world",
      new_string: "hello crab",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("1 replacement");
    expect(read("a.txt")).toBe("hello crab\nbye world\n");
  });

  it("rejects when old_string appears multiple times without replace_all", async () => {
    write("b.txt", "foo\nfoo\nfoo\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "b.txt",
      old_string: "foo",
      new_string: "bar",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("3 locations");
    expect(read("b.txt")).toBe("foo\nfoo\nfoo\n");
  });

  it("replaces every occurrence when replace_all is true", async () => {
    write("c.txt", "foo\nfoo\nfoo\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "c.txt",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("3 replacements");
    expect(read("c.txt")).toBe("bar\nbar\nbar\n");
  });

  it("rejects when old_string is not found", async () => {
    write("d.txt", "nothing to see here\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "d.txt",
      old_string: "missing",
      new_string: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });

  it("rejects when old_string equals new_string", async () => {
    write("e.txt", "same\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "e.txt",
      old_string: "same",
      new_string: "same",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("identical");
  });

  it("rejects empty old_string", async () => {
    write("f.txt", "content\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "f.txt",
      old_string: "",
      new_string: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must not be empty");
  });

  it("rejects missing file", async () => {
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "nope.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("File not found");
  });

  it("rejects paths outside the workspace", async () => {
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "../escape.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Access denied");
  });

  it("rejects editing write-protected .git paths", async () => {
    // Simulate a .git/config file
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: ".git/config",
      old_string: "[core]",
      new_string: "[evil]",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("protected");
    expect(existsSync(join(workspace, ".git", "config"))).toBe(true);
  });

  it("rejects binary extensions", async () => {
    write("x.png", "not really an image");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "x.png",
      old_string: "not",
      new_string: "maybe",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("binary extension");
  });

  it("handles multi-line replacement", async () => {
    write("g.txt", "line1\nline2\nline3\nline4\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "g.txt",
      old_string: "line2\nline3",
      new_string: "replacement",
    });
    expect(res.isError).toBeFalsy();
    expect(read("g.txt")).toBe("line1\nreplacement\nline4\n");
    expect(res.content).toContain("-1 lines");
  });

  it("routes the replacement write through writeFileAtomic (RT-2026-05-01-003)", async () => {
    write("atomic-edit.txt", "OLD content here\n");
    const handler = getToolHandler("file_edit");
    const res = await handler({
      path: "atomic-edit.txt",
      old_string: "OLD",
      new_string: "NEW",
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(read("atomic-edit.txt")).toBe("NEW content here\n");
  });
});
