import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { jailPath, verifyJailedPath } from "./path-jail.js";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbiter-jail-"));
}

describe("jailPath", () => {
  it("accepts a simple relative path", async () => {
    const r = jailPath("story.txt", await ws());
    expect(r.ok).toBe(true);
    expect(r.path).toMatch(/story\.txt$/);
  });

  it("rejects ../ traversal", async () => {
    expect(jailPath("../../etc/passwd", await ws()).ok).toBe(false);
    expect(jailPath("../escape.txt", await ws()).ok).toBe(false);
  });

  it("rejects backslash traversal on Windows-style input", async () => {
    expect(jailPath("..\\..\\windows\\system32", await ws()).ok).toBe(false);
  });

  it("rejects absolute Unix system paths", async () => {
    const r = jailPath("/etc/passwd", await ws());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/system|absolute/);
  });

  it("rejects Windows drive-letter absolutes", async () => {
    expect(jailPath("C:\\Windows\\System32", await ws()).ok).toBe(false);
    expect(jailPath("c:/users/admin", await ws()).ok).toBe(false);
  });

  it("rejects UNC paths", async () => {
    expect(jailPath("\\\\server\\share\\file", await ws()).ok).toBe(false);
  });

  it("rejects null-byte injection", async () => {
    expect(jailPath("ok.txt\0.png", await ws()).ok).toBe(false);
  });

  it("rejects empty path", async () => {
    expect(jailPath("", await ws()).ok).toBe(false);
  });

  it("accepts nested workspace paths", async () => {
    const r = jailPath("notes/draft/v1.md", await ws());
    expect(r.ok).toBe(true);
  });
});

describe("verifyJailedPath — realpath/symlink guard (RT-2026-04-30-006)", () => {
  it("accepts an ordinary in-workspace target", async () => {
    const workspace = await ws();
    const lex = jailPath("notes.md", workspace);
    expect(lex.ok).toBe(true);
    const r = await verifyJailedPath(lex.path!, workspace);
    expect(r.ok).toBe(true);
  });

  it("rejects a target whose parent dir symlinks outside the workspace", async () => {
    if (platform() === "win32") {
      // Windows symlink creation requires elevated privileges in many setups;
      // skip noisily rather than let CI flap. The realpath check still applies
      // there; this assertion is the POSIX coverage.
      return;
    }
    const workspace = await ws();
    const outside = await mkdtemp(join(tmpdir(), "arbiter-outside-"));
    await mkdir(join(workspace, "evil"), { recursive: true });
    // Replace `evil` with a symlink pointing outside.
    await symlink(outside, join(workspace, "escape"));
    const lex = jailPath("escape/file.txt", workspace);
    // Lexical jail accepts — escape/file.txt is below workspace lexically.
    expect(lex.ok).toBe(true);
    // Realpath jail must reject.
    const r = await verifyJailedPath(lex.path!, workspace);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/symlink|escapes/);
  });
});
