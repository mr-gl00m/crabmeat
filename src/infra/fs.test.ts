import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFileAtomic,
  writeJsonAtomic,
  sweepAtomicTmpFiles,
} from "./fs.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-fs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves no tmp file behind on success", async () => {
    await writeFileAtomic(join(dir, "data.json"), '{"ok":true}');
    const entries = await readdir(dir);
    expect(entries).toEqual(["data.json"]);
  });

  it("unlinks tmp file when rename fails", async () => {
    // Force rename to fail by making the target path a directory: rename
    // of a file onto an existing non-empty directory fails (EISDIR / EPERM).
    const target = join(dir, "isdir");
    await mkdir(target);
    await writeFile(join(target, "child"), "x", "utf-8");

    await expect(writeFileAtomic(target, "payload")).rejects.toThrow();

    const orphans = (await readdir(dir)).filter((e) => e.includes(".tmp."));
    expect(orphans).toEqual([]);
  });
});

describe("sweepAtomicTmpFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-sweep-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes orphan .tmp.<token> files and leaves real files alone", async () => {
    await writeFile(join(dir, "real.json"), "{}", "utf-8");
    await writeFile(join(dir, "real.json.tmp.abcd-1234"), "{}", "utf-8");
    await writeFile(join(dir, "other.json.tmp.9999"), "x", "utf-8");
    await writeFile(join(dir, "notes.txt"), "hi", "utf-8");

    const removed = await sweepAtomicTmpFiles(dir);
    expect(removed).toBe(2);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(["notes.txt", "real.json"]);
  });

  it("returns 0 for a missing directory without throwing", async () => {
    const removed = await sweepAtomicTmpFiles(join(dir, "does-not-exist"));
    expect(removed).toBe(0);
  });

  it("is a no-op on a directory with no tmp files", async () => {
    await writeFileAtomic(join(dir, "a.json"), "{}");
    await writeJsonAtomic(join(dir, "b.json"), { x: 1 });

    const removed = await sweepAtomicTmpFiles(dir);
    expect(removed).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);
  });
});
