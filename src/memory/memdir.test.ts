import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanMemdir,
  readEntrypoint,
  writeEntrypoint,
  measureEntrypoint,
  formatManifest,
  MEMDIR_ENTRYPOINT_MAX_LINES,
  MEMDIR_ENTRYPOINT_MAX_BYTES,
} from "./memdir.js";

describe("memdir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-memdir-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("scanMemdir", () => {
    it("returns empty array for missing directory", async () => {
      const result = await scanMemdir(join(dir, "nope"));
      expect(result).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      const result = await scanMemdir(dir);
      expect(result).toEqual([]);
    });

    it("reads .md files and returns headers newest-first", async () => {
      await writeFile(join(dir, "older.md"), "# older entry\nbody");
      // Force a gap so mtimes are distinct on fast filesystems
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(dir, "newer.md"), "# newer entry\nbody");

      const result = await scanMemdir(dir);
      expect(result).toHaveLength(2);
      expect(result[0]!.key).toBe("newer");
      expect(result[1]!.key).toBe("older");
      expect(result[0]!.description).toContain("newer entry");
    });

    it("skips the MEMORY.md entrypoint", async () => {
      await writeFile(join(dir, "MEMORY.md"), "# index");
      await writeFile(join(dir, "actual.md"), "# actual memory");
      const result = await scanMemdir(dir);
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe("actual");
    });

    it("skips hidden files and non-.md files", async () => {
      await writeFile(join(dir, ".cortexdream-lock"), "123");
      await writeFile(join(dir, "notes.txt"), "not markdown");
      await writeFile(join(dir, "real.md"), "# real");
      const result = await scanMemdir(dir);
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe("real");
    });

    it("enforces maxFiles cap", async () => {
      for (let i = 0; i < 10; i++) {
        await writeFile(join(dir, `m${i}.md`), `# entry ${i}`);
      }
      const result = await scanMemdir(dir, 3);
      expect(result).toHaveLength(3);
    });

    it("skips subdirectories gracefully", async () => {
      await mkdir(join(dir, "subdir"));
      await writeFile(join(dir, "file.md"), "# ok");
      const result = await scanMemdir(dir);
      expect(result).toHaveLength(1);
      expect(result[0]!.key).toBe("file");
    });
  });

  describe("measureEntrypoint", () => {
    it("reports no warning for under-cap content", () => {
      const report = measureEntrypoint("small content\n");
      expect(report.overLineCap).toBe(false);
      expect(report.overByteCap).toBe(false);
      expect(report.warning).toBeUndefined();
    });

    it("flags line cap", () => {
      const content = "line\n".repeat(MEMDIR_ENTRYPOINT_MAX_LINES + 5);
      const report = measureEntrypoint(content);
      expect(report.overLineCap).toBe(true);
      expect(report.warning).toContain("line cap");
    });

    it("flags byte cap", () => {
      const content = "x".repeat(MEMDIR_ENTRYPOINT_MAX_BYTES + 100);
      const report = measureEntrypoint(content);
      expect(report.overByteCap).toBe(true);
      expect(report.warning).toContain("byte cap");
    });

    it("flags both caps when both exceeded", () => {
      const line = "x".repeat(200) + "\n";
      const content = line.repeat(MEMDIR_ENTRYPOINT_MAX_LINES + 10);
      const report = measureEntrypoint(content);
      expect(report.overLineCap).toBe(true);
      expect(report.overByteCap).toBe(true);
      expect(report.warning).toContain("both caps");
    });
  });

  describe("readEntrypoint + writeEntrypoint", () => {
    it("reads undefined for missing entrypoint", async () => {
      expect(await readEntrypoint(dir)).toBeUndefined();
    });

    it("writes then reads entrypoint round-trip", async () => {
      const content = "# MEMORY\n- entry 1\n- entry 2\n";
      await writeEntrypoint(dir, content);
      expect(await readEntrypoint(dir)).toBe(content);
    });

    it("creates memoryDir if missing", async () => {
      const newDir = join(dir, "nested", "memdir");
      await writeEntrypoint(newDir, "# hi\n");
      expect(await readEntrypoint(newDir)).toBe("# hi\n");
    });
  });

  describe("formatManifest", () => {
    it("produces one row per header", () => {
      const out = formatManifest([
        {
          key: "user_role",
          path: "/x/user_role.md",
          mtime: "2026-01-01T00:00:00.000Z",
          sizeBytes: 120,
          description: "user is a data scientist",
        },
        {
          key: "feedback_style",
          path: "/x/feedback_style.md",
          mtime: "2026-02-01T00:00:00.000Z",
          sizeBytes: 80,
        },
      ]);
      expect(out.split("\n")).toHaveLength(2);
      expect(out).toContain("user_role");
      expect(out).toContain("2026-01-01");
      expect(out).toContain("data scientist");
      expect(out).toContain("feedback_style");
    });
  });
});
