import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap infra/fs so RT-2026-05-01-002 can verify that file_write routes
// through writeFileAtomic instead of the raw fs.writeFile that left the
// target truncatable on a crash. By default the wrapped fn delegates to
// the real implementation so the rest of the suite keeps real-fs
// semantics.
vi.mock("../../infra/fs.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/fs.js")>(
    "../../infra/fs.js",
  );
  return {
    ...actual,
    writeFileAtomic: vi.fn(actual.writeFileAtomic),
  };
});

import {
  registerBuiltinTools,
  setWorkspaceRoot,
  setFileAccessPaths,
  setDryRunBulkThreshold,
  getDryRunBulkThreshold,
  clearPendingPreviews,
} from "./builtins.js";
import { getToolHandler } from "./handlers.js";
import { writeFileAtomic } from "../../infra/fs.js";

const writeFileAtomicMock = vi.mocked(writeFileAtomic);

let workspace: string;
let extraRoot: string;
let originalCwd: string;
let originalThreshold: number;

beforeAll(() => {
  originalCwd = process.cwd();
  originalThreshold = getDryRunBulkThreshold();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-dryrun-"));
  extraRoot = mkdtempSync(join(tmpdir(), "crabmeat-extra-root-"));
  setWorkspaceRoot(workspace);
  setFileAccessPaths([extraRoot]);
  registerBuiltinTools();
});

afterAll(() => {
  setWorkspaceRoot(originalCwd);
  setFileAccessPaths([]);
  setDryRunBulkThreshold(originalThreshold);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(extraRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  rmSync(extraRoot, { recursive: true, force: true });
  mkdirSync(extraRoot, { recursive: true });
  clearPendingPreviews();
  setDryRunBulkThreshold(originalThreshold);
  writeFileAtomicMock.mockClear();
});

function writeFile(rel: string, content: string): void {
  writeFileSync(join(workspace, rel), content, "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(join(workspace, rel));
}

function read(rel: string): string {
  return readFileSync(join(workspace, rel), "utf-8");
}

describe("file_write dry_run + overwrite gate", () => {
  it("dry_run on a non-existent file reports would-create, leaves disk untouched", async () => {
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "new.txt",
      content: "hello",
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.created).toBe(true);
    expect(res.outputs?.prior_size).toBe(0);
    expect(res.outputs?.prior_hash).toBe("");
    expect(res.outputs?.bytes_written).toBe(0);
    expect(res.outputs?.parent_op_id).toMatch(/^op_[0-9a-f]{32}$/);
    expect(exists("new.txt")).toBe(false);
  });

  it("dry_run on an existing file reports prior size + hash, leaves content untouched", async () => {
    writeFile("target.txt", "original content");
    const expectedHash = createHash("sha256").update("original content").digest("hex");

    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "target.txt",
      content: "REPLACEMENT",
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.created).toBe(false);
    expect(res.outputs?.prior_size).toBe(Buffer.byteLength("original content"));
    expect(res.outputs?.prior_hash).toBe(expectedHash);
    expect(read("target.txt")).toBe("original content");
  });

  it("refuses to overwrite an existing file without overwrite:true", async () => {
    writeFile("existing.txt", "keep me");
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "existing.txt",
      content: "REPLACEMENT",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/already exists/);
    expect(res.outputs?.prior_hash).toHaveLength(64);
    expect(read("existing.txt")).toBe("keep me");
  });

  it("overwrites an existing file when overwrite:true is passed", async () => {
    writeFile("existing.txt", "keep me");
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "existing.txt",
      content: "REPLACEMENT",
      overwrite: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(false);
    expect(res.outputs?.created).toBe(false);
    expect(read("existing.txt")).toBe("REPLACEMENT");
  });

  it("creates a new file without overwrite:true (gate only applies to existing files)", async () => {
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "brand-new.txt",
      content: "fresh",
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.created).toBe(true);
    expect(read("brand-new.txt")).toBe("fresh");
  });

  it("routes the create path through writeFileAtomic (RT-2026-05-01-002)", async () => {
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "atomic-new.txt",
      content: "fresh",
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(read("atomic-new.txt")).toBe("fresh");
  });

  it("routes the overwrite path through writeFileAtomic (RT-2026-05-01-002)", async () => {
    writeFile("existing-atomic.txt", "OLD");
    const handler = getToolHandler("file_write");
    const res = await handler({
      path: "existing-atomic.txt",
      content: "NEW",
      overwrite: true,
    });
    expect(res.isError).toBeFalsy();
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(read("existing-atomic.txt")).toBe("NEW");
  });
});

describe("file_move dry_run + threshold", () => {
  it("dry_run returns plan, leaves files in place", async () => {
    writeFile("a.txt", "1");
    writeFile("b.txt", "22");
    mkdirSync(join(workspace, "archive"), { recursive: true });

    const handler = getToolHandler("file_move");
    const res = await handler({
      sources: ["a.txt", "b.txt"],
      destination: "archive/",
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.count).toBe(0);
    expect((res.outputs?.plan as unknown[]).length).toBe(2);
    expect(res.outputs?.total_bytes).toBe(3);
    expect(res.outputs?.confirm_token).toMatch(/^cft_[0-9a-f]+$/);
    expect(exists("a.txt")).toBe(true);
    expect(exists("b.txt")).toBe(true);
    expect(exists("archive/a.txt")).toBe(false);
  });

  it("bulk move above threshold without token returns plan + confirm_token and refuses to execute", async () => {
    setDryRunBulkThreshold(2);
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    writeFile("c.txt", "z");
    mkdirSync(join(workspace, "out"), { recursive: true });

    const handler = getToolHandler("file_move");
    const res = await handler({
      sources: ["a.txt", "b.txt", "c.txt"],
      destination: "out/",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/exceeds the bulk threshold/);
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.confirm_token).toMatch(/^cft_/);
    // Nothing moved
    expect(exists("a.txt")).toBe(true);
    expect(exists("b.txt")).toBe(true);
    expect(exists("c.txt")).toBe(true);
    expect(exists("out/a.txt")).toBe(false);
  });

  it("bulk move with matching confirm_token executes the plan", async () => {
    setDryRunBulkThreshold(2);
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    writeFile("c.txt", "z");
    mkdirSync(join(workspace, "out"), { recursive: true });

    const handler = getToolHandler("file_move");
    const preview = await handler({
      sources: ["a.txt", "b.txt", "c.txt"],
      destination: "out/",
    });
    const token = preview.outputs?.confirm_token as string;
    expect(token).toBeTruthy();

    const res = await handler({
      sources: ["a.txt", "b.txt", "c.txt"],
      destination: "out/",
      confirm_token: token,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.count).toBe(3);
    expect(exists("a.txt")).toBe(false);
    expect(exists("out/a.txt")).toBe(true);
    expect(exists("out/b.txt")).toBe(true);
    expect(exists("out/c.txt")).toBe(true);
  });

  it("rejects a confirm_token minted for a different plan", async () => {
    setDryRunBulkThreshold(2);
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    writeFile("c.txt", "z");
    writeFile("d.txt", "q");
    mkdirSync(join(workspace, "out"), { recursive: true });

    const handler = getToolHandler("file_move");
    const preview = await handler({
      sources: ["a.txt", "b.txt", "c.txt"],
      destination: "out/",
    });
    const token = preview.outputs?.confirm_token as string;

    // Try to reuse the token with a different source set
    const res = await handler({
      sources: ["b.txt", "c.txt", "d.txt"],
      destination: "out/",
      confirm_token: token,
    });
    expect(res.isError).toBe(true);
    expect(res.outputs?.dry_run).toBe(true);
    // Originals still in place
    expect(exists("b.txt")).toBe(true);
    expect(exists("d.txt")).toBe(true);
  });

  it("small moves below threshold execute without a token", async () => {
    setDryRunBulkThreshold(10);
    writeFile("a.txt", "x");
    mkdirSync(join(workspace, "out"), { recursive: true });
    const handler = getToolHandler("file_move");
    const res = await handler({ source: "a.txt", destination: "out/" });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.count).toBe(1);
    expect(exists("out/a.txt")).toBe(true);
  });
});

describe("file_copy dry_run + threshold", () => {
  it("dry_run returns plan and copies nothing", async () => {
    writeFile("src.txt", "payload");
    mkdirSync(join(workspace, "archive"), { recursive: true });

    const handler = getToolHandler("file_copy");
    const res = await handler({
      source: "src.txt",
      destination: "archive/",
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.count).toBe(0);
    expect((res.outputs?.plan as unknown[]).length).toBe(1);
    expect(exists("archive/src.txt")).toBe(false);
    expect(exists("src.txt")).toBe(true);
  });

  it("bulk copy above threshold without token returns plan and refuses", async () => {
    setDryRunBulkThreshold(1);
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    mkdirSync(join(workspace, "out"), { recursive: true });

    const handler = getToolHandler("file_copy");
    const res = await handler({
      sources: ["a.txt", "b.txt"],
      destination: "out/",
    });
    expect(res.isError).toBe(true);
    expect(res.outputs?.confirm_token).toMatch(/^cft_/);
    expect(exists("out/a.txt")).toBe(false);
    expect(exists("out/b.txt")).toBe(false);
  });

  it("bulk copy with matching confirm_token executes", async () => {
    setDryRunBulkThreshold(1);
    writeFile("a.txt", "x");
    writeFile("b.txt", "y");
    mkdirSync(join(workspace, "out"), { recursive: true });

    const handler = getToolHandler("file_copy");
    const preview = await handler({
      sources: ["a.txt", "b.txt"],
      destination: "out/",
    });
    const token = preview.outputs?.confirm_token as string;

    const res = await handler({
      sources: ["a.txt", "b.txt"],
      destination: "out/",
      confirm_token: token,
    });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.count).toBe(2);
    expect(exists("out/a.txt")).toBe(true);
    expect(exists("out/b.txt")).toBe(true);
    // Originals still present (copy, not move)
    expect(exists("a.txt")).toBe(true);
  });
});

describe("shell dry_run", () => {
  it("dry_run returns would-execute and does not spawn a child process", async () => {
    const handler = getToolHandler("shell");
    const res = await handler({
      command: "echo hello-from-dry-run > would-not-exist.txt",
      dry_run: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/DRY RUN — would execute:/);
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.stdout).toBe("");
    expect(res.outputs?.stderr).toBe("");
    expect(res.outputs?.exit_code).toBe(0);
    expect(res.outputs?.parent_op_id).toMatch(/^op_[0-9a-f]{32}$/);
    // No side effect
    expect(exists("would-not-exist.txt")).toBe(false);
  });

  it("dry_run still enforces the denylist", async () => {
    const handler = getToolHandler("shell");
    const res = await handler({
      command: "rm -rf /",
      dry_run: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/denied by security policy/);
  });

  it("executes with cwd inside an extra allowed root", async () => {
    const handler = getToolHandler("shell");
    const command = process.platform === "win32" ? "cd" : "pwd";
    const res = await handler({ command, cwd: extraRoot });
    expect(res.isError).toBeFalsy();
    expect((res.outputs?.cwd as string).toLowerCase()).toBe(extraRoot.toLowerCase());
  });

  it("rejects cwd outside configured roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "crabmeat-outside-root-"));
    try {
      const handler = getToolHandler("shell");
      const res = await handler({ command: "echo blocked", cwd: outside });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/outside allowed directories/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
