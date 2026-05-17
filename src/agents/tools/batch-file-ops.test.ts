/**
 * Tests for the 5 batch file-ops tools ported from Cid's Python tools:
 * rename_files_dirty, flatten_folder, clean_junk_files, rename_episodes,
 * rename_rom_files.
 *
 * Uses a per-test tempdir under the OS tmp so the workspace jail allows
 * writes. The jail is configured by registerBuiltinTools with an
 * extraAllowedPaths entry pointing at the tempdir root.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerBuiltinTools, setFileAccessPaths, setWorkspaceRoot } from "./builtins.js";
import { getToolHandler } from "./handlers.js";

let tmpRoot: string;

beforeAll(() => {
  registerBuiltinTools();
});

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "crabmeat-batch-"));
  setWorkspaceRoot(tmpRoot);
  setFileAccessPaths([tmpRoot]);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function touch(relPath: string, content = ""): Promise<string> {
  const abs = join(tmpRoot, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

async function listNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.sort();
}

// ── rename_files_dirty ────────────────────────────────────

describe("rename_files_dirty", () => {
  it("strips brackets and normalizes separators in dry run", async () => {
    await touch("Some Movie (2024) [1080p].mp4");
    await touch("Another.File.Name-Here.txt");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.dry_run).toBe(true);
    const plan = res.outputs?.plan as Array<{ old: string; new: string }>;
    const pair = plan.find((p) => p.old === "Some Movie (2024) [1080p].mp4");
    expect(pair?.new).toBe("some_movie_2024_1080p.mp4");
    const pair2 = plan.find((p) => p.old === "Another.File.Name-Here.txt");
    expect(pair2?.new).toBe("another_file_name_here.txt");
  });

  it("executes when dry_run is false and plan is small", async () => {
    await touch("HELLO WORLD.txt");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
    const names = await listNames(tmpRoot);
    expect(names).toContain("hello_world.txt");
    expect(names).not.toContain("HELLO WORLD.txt");
  });

  it("skips hidden files", async () => {
    await touch(".hiddenFile.txt");
    await touch("visible file.txt");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
    const names = await listNames(tmpRoot);
    expect(names).toContain(".hiddenFile.txt");
    expect(names).toContain("visible_file.txt");
  });

  it("skips files that don't change", async () => {
    await touch("already_clean.mp4");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    expect((res.outputs?.plan as unknown[]).length).toBe(0);
  });

  it("skips when target name collides with existing file", async () => {
    await touch("hello world.txt");
    await touch("hello_world.txt", "existing");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    const skipped = res.outputs?.skipped as Array<{ name: string; reason: string }>;
    expect(skipped.some((s) => s.name === "hello world.txt")).toBe(true);
  });

  it("is non-recursive by default", async () => {
    await touch("TOP file.txt");
    await touch("sub/NESTED file.txt");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
  });

  it("descends when recursive:true", async () => {
    await touch("TOP file.txt");
    await touch("sub/NESTED file.txt");
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: false, recursive: true });
    expect(res.outputs?.count).toBe(2);
  });
});

// ── flatten_folder ────────────────────────────────────────

describe("flatten_folder", () => {
  it("moves nested files to root", async () => {
    await touch("sub1/a.txt");
    await touch("sub2/deeper/b.txt");
    await touch("existing.txt");
    const handler = getToolHandler("flatten_folder");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(2);
    const names = await listNames(tmpRoot);
    expect(names).toEqual(expect.arrayContaining(["a.txt", "b.txt", "existing.txt"]));
  });

  it("auto-renames on collision with _1 _2 suffix", async () => {
    await touch("file.txt", "root");
    await touch("sub1/file.txt", "sub1");
    await touch("sub2/file.txt", "sub2");
    const handler = getToolHandler("flatten_folder");
    await handler({ folder: tmpRoot, dry_run: false });
    const names = await listNames(tmpRoot);
    expect(names).toContain("file.txt");
    expect(names).toContain("file_1.txt");
    expect(names).toContain("file_2.txt");
  });

  it("removes empty subdirectories after flatten", async () => {
    await touch("sub/file.txt");
    const handler = getToolHandler("flatten_folder");
    await handler({ folder: tmpRoot, dry_run: false });
    const names = await listNames(tmpRoot);
    expect(names).not.toContain("sub");
    expect(names).toContain("file.txt");
  });

  it("dry_run reports plan without moving", async () => {
    await touch("sub/x.txt");
    const handler = getToolHandler("flatten_folder");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.confirm_token).toMatch(/^cft_/);
    // sub/x.txt should still be nested
    const nested = await readdir(join(tmpRoot, "sub"));
    expect(nested).toContain("x.txt");
  });
});

// ── clean_junk_files ──────────────────────────────────────

describe("clean_junk_files", () => {
  it("deletes files matching default junk list", async () => {
    await touch("download.nfo");
    await touch("download.sfv");
    await touch("keeper.mp4");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(2);
    const names = await listNames(tmpRoot);
    expect(names).toEqual(["keeper.mp4"]);
  });

  it("accepts custom junk_extensions with or without leading dot", async () => {
    await touch("x.bak");
    await touch("y.tmp");
    await touch("z.keep");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({
      folder: tmpRoot,
      junk_extensions: ["bak", ".tmp"],
      dry_run: false,
    });
    expect(res.outputs?.count).toBe(2);
    const names = await listNames(tmpRoot);
    expect(names).toEqual(["z.keep"]);
  });

  it("is case-insensitive on extension", async () => {
    await touch("x.NFO");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
  });

  it("recurses by default", async () => {
    await touch("sub/deep.nfo");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
  });

  it("reports total bytes freed", async () => {
    await touch("a.nfo", "hello");
    await touch("b.sfv", "world!!");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.bytes_freed).toBe(12);
  });

  it("dry_run reports total_bytes without deleting", async () => {
    await touch("a.nfo", "hello");
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    expect(res.outputs?.dry_run).toBe(true);
    expect(res.outputs?.total_bytes).toBe(5);
    // file still there
    const names = await listNames(tmpRoot);
    expect(names).toContain("a.nfo");
  });

  it("refuses empty junk_extensions", async () => {
    const handler = getToolHandler("clean_junk_files");
    const res = await handler({ folder: tmpRoot, junk_extensions: [], dry_run: false });
    expect(res.isError).toBe(true);
  });
});

// ── rename_episodes ───────────────────────────────────────

describe("rename_episodes", () => {
  it("applies default episode pattern with zero-padding", async () => {
    await touch("The Show - Ep5 - Pilot.mkv");
    await touch("The Show - Ep10 - Finale.mkv");
    const handler = getToolHandler("rename_episodes");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(2);
    const names = await listNames(tmpRoot);
    expect(names).toContain("The Show - s01e05 - Pilot.mkv");
    expect(names).toContain("The Show - s01e10 - Finale.mkv");
  });

  it("skips files that don't match the pattern", async () => {
    await touch("matches - Ep1 - title.mkv");
    await touch("no-match.mkv");
    const handler = getToolHandler("rename_episodes");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    const skipped = res.outputs?.skipped as Array<{ name: string; reason: string }>;
    expect(skipped.some((s) => s.name === "no-match.mkv")).toBe(true);
  });

  it("accepts custom pattern + replacement", async () => {
    await touch("show.s01.e03.title.mkv");
    const handler = getToolHandler("rename_episodes");
    const res = await handler({
      folder: tmpRoot,
      pattern: "(.+)\\.s(\\d+)\\.e(\\d+)\\.(.+)",
      replacement: "$1 - s$2e$3 - $4",
      dry_run: false,
    });
    expect(res.outputs?.count).toBe(1);
    const names = await listNames(tmpRoot);
    expect(names).toContain("show - s01e03 - title.mkv");
  });

  it("rejects invalid regex", async () => {
    const handler = getToolHandler("rename_episodes");
    const res = await handler({ folder: tmpRoot, pattern: "(unclosed", dry_run: true });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid regex");
  });
});

// ── rename_rom_files ──────────────────────────────────────

describe("rename_rom_files", () => {
  it("applies system tag from extension", async () => {
    await touch("Super Mario Bros..nes");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(1);
    const names = await listNames(tmpRoot);
    expect(names.some((n) => n.endsWith("[NES].nes"))).toBe(true);
  });

  it("strips existing tags and rebuilds canonical form", async () => {
    await touch("Zelda (USA) [v1.0].sfc");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    const names = await listNames(tmpRoot);
    // USA and v1.0 tags should be stripped; SNES detected from .sfc
    expect(names).toContain("Zelda [SNES].sfc");
  });

  it("preserves disc number", async () => {
    await touch("FF7 (Disc 2).cue");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    const names = await listNames(tmpRoot);
    expect(names.some((n) => /\(Disc 2\)/.test(n))).toBe(true);
  });

  it("preserves translation tag", async () => {
    await touch("Mother 3 [T+Eng].gba");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    const names = await listNames(tmpRoot);
    expect(names.some((n) => /\[E-Tr\]/.test(n))).toBe(true);
  });

  it("skips unknown extensions without system_override", async () => {
    await touch("something.xyz");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: true });
    const skipped = res.outputs?.skipped as Array<{ name: string; reason: string }>;
    expect(skipped.some((s) => s.name === "something.xyz")).toBe(true);
  });

  it("processes unknown extensions when system_override is set", async () => {
    await touch("something.xyz");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({
      folder: tmpRoot,
      system_override: "CUSTOM",
      dry_run: false,
    });
    expect(res.outputs?.count).toBe(1);
    const names = await listNames(tmpRoot);
    expect(names.some((n) => n.endsWith("[CUSTOM].xyz"))).toBe(true);
  });

  it("recurses by default", async () => {
    await touch("Pokemon.gb");
    await touch("SNES/Mario.sfc");
    const handler = getToolHandler("rename_rom_files");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.outputs?.count).toBe(2);
  });
});

// ── cross-cutting: dry_run + confirm_token gating ─────────

describe("bulk threshold + confirm_token", () => {
  it("rename_files_dirty refuses bulk (>25) without confirm_token and returns one", async () => {
    for (let i = 0; i < 30; i++) {
      await touch(`Messy File ${i}.txt`);
    }
    const handler = getToolHandler("rename_files_dirty");
    const res = await handler({ folder: tmpRoot, dry_run: false });
    expect(res.isError).toBe(true);
    expect(res.outputs?.confirm_token).toMatch(/^cft_/);
    expect(res.outputs?.dry_run).toBe(true);
  });

  it("confirm_token from dry_run authorizes execute of the same plan", async () => {
    for (let i = 0; i < 30; i++) {
      await touch(`File ${i}.txt`);
    }
    const handler = getToolHandler("rename_files_dirty");
    const preview = await handler({ folder: tmpRoot, dry_run: true });
    const token = preview.outputs?.confirm_token as string;
    expect(token).toMatch(/^cft_/);
    const execute = await handler({ folder: tmpRoot, dry_run: false, confirm_token: token });
    expect(execute.outputs?.count).toBe(30);
  });
});
