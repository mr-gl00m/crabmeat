/**
 * Regression coverage for RT-2026-05-01-004: memory_write must persist
 * through writeFileAtomic for both overwrite and append modes so a
 * crash mid-write cannot corrupt durable agent memory.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { getToolHandler } from "./handlers.js";
import { writeFileAtomic } from "../../infra/fs.js";

const writeFileAtomicMock = vi.mocked(writeFileAtomic);

let workspace: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-memwrite-"));
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

function memPath(key: string): string {
  return join(workspace, ".crabmeat", "memory", `${key}.md`);
}

describe("memory_write atomic persistence (RT-2026-05-01-004)", () => {
  it("routes overwrite mode through writeFileAtomic", async () => {
    const handler = getToolHandler("memory_write");
    const res = await handler({
      key: "ow",
      content: "hello memory",
      mode: "overwrite",
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(memPath("ow"), "utf-8")).toBe("hello memory");
  });

  it("routes append mode through writeFileAtomic", async () => {
    const handler = getToolHandler("memory_write");
    const res = await handler({
      key: "ap",
      content: "first entry",
      mode: "append",
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    const onDisk = readFileSync(memPath("ap"), "utf-8");
    expect(onDisk).toContain("first entry");
  });

  it("append preserves prior content and adds the new entry atomically", async () => {
    // Seed a pre-existing memory file the way a prior session would have.
    mkdirSync(join(workspace, ".crabmeat", "memory"), { recursive: true });
    writeFileSync(memPath("ap2"), "PRIOR CONTENT\n", "utf-8");

    const handler = getToolHandler("memory_write");
    const res = await handler({
      key: "ap2",
      content: "second entry",
      mode: "append",
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    const onDisk = readFileSync(memPath("ap2"), "utf-8");
    expect(onDisk).toContain("PRIOR CONTENT");
    expect(onDisk).toContain("second entry");
  });

  it("leaves no orphan tmp files in the memory dir after a successful write", async () => {
    const handler = getToolHandler("memory_write");
    await handler({ key: "clean", content: "x", mode: "overwrite" });
    const memDir = join(workspace, ".crabmeat", "memory");
    const entries = require("node:fs").readdirSync(memDir);
    const orphans = entries.filter((n: string) => n.includes(".tmp."));
    expect(orphans).toEqual([]);
    expect(existsSync(memPath("clean"))).toBe(true);
  });
});
