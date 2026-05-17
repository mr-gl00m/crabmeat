import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  releaseLock,
  readLastConsolidatedMs,
  isPidAlive,
} from "./cortexdream-lock.js";

describe("cortexdream-lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("readLastConsolidatedMs", () => {
    it("returns 0 when lock does not exist", async () => {
      expect(await readLastConsolidatedMs(dir)).toBe(0);
    });

    it("returns mtime in ms when lock exists", async () => {
      await writeFile(join(dir, ".cortexdream-lock"), String(process.pid));
      const stamped = new Date(2026, 1, 15);
      await utimes(join(dir, ".cortexdream-lock"), stamped, stamped);
      const val = await readLastConsolidatedMs(dir);
      expect(val).toBeGreaterThan(0);
      expect(Math.abs(val - stamped.getTime())).toBeLessThan(2000);
    });
  });

  describe("acquireLock", () => {
    it("acquires on first call (no lock file)", async () => {
      const result = await acquireLock(dir, 60_000);
      expect(result.acquired).toBe(true);
      expect(result.priorMtimeMs).toBe(0);
      const body = await readFile(join(dir, ".cortexdream-lock"), "utf-8");
      expect(body.trim()).toBe(String(process.pid));
    });

    it("refuses when lock is held by a live PID within staleMs", async () => {
      // Write a lock file owned by our own PID (which is definitely alive)
      // and stamped now so it's fresh. The lock should refuse — a fresh
      // live-PID lock means "a run is in flight," and we rely on the
      // in-process `runningFor` flag (not the file lock) to allow
      // legitimate same-process sequential runs.
      await writeFile(join(dir, ".cortexdream-lock"), String(process.pid));
      const result = await acquireLock(dir, 60 * 60 * 1000);
      expect(result.acquired).toBe(false);
      expect(result.heldByPid).toBe(process.pid);
    });

    it("reclaims a stale lock (mtime too old)", async () => {
      // Write a lock with a bogus PID and backdate it
      await writeFile(join(dir, ".cortexdream-lock"), "999999");
      const ancient = new Date(2020, 0, 1);
      await utimes(join(dir, ".cortexdream-lock"), ancient, ancient);

      const result = await acquireLock(dir, 60 * 1000);
      expect(result.acquired).toBe(true);
      expect(result.priorMtimeMs).toBeGreaterThan(0); // we captured it
      const body = await readFile(join(dir, ".cortexdream-lock"), "utf-8");
      expect(body.trim()).toBe(String(process.pid));
    });

    it("reclaims a lock held by a dead PID even if mtime is fresh", async () => {
      // PID 1 is init on POSIX / System on Windows — almost certainly
      // alive. Use a PID we can be confident is dead. Actually — safest
      // approach: use a PID that is definitely not running. On most
      // systems, PID 99999999 is unlikely to exist.
      await writeFile(join(dir, ".cortexdream-lock"), "99999999");
      const result = await acquireLock(dir, 60 * 60 * 1000);
      expect(result.acquired).toBe(true);
    });

    it("priorMtimeMs is 0 for a brand-new lock", async () => {
      const result = await acquireLock(dir, 60_000);
      expect(result.priorMtimeMs).toBe(0);
    });

    it("priorMtimeMs captures existing mtime when reclaiming", async () => {
      await writeFile(join(dir, ".cortexdream-lock"), "99999999");
      const oldDate = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago
      await utimes(join(dir, ".cortexdream-lock"), oldDate, oldDate);

      const result = await acquireLock(dir, 60 * 60 * 1000);
      expect(result.acquired).toBe(true);
      expect(result.priorMtimeMs).toBeGreaterThan(0);
      expect(Math.abs(result.priorMtimeMs - oldDate.getTime())).toBeLessThan(5000);
    });
  });

  describe("releaseLock", () => {
    it("bumps mtime to now on recordConsolidation=true", async () => {
      await acquireLock(dir, 60_000);
      // Backdate so we can observe the bump
      const ancient = new Date(2020, 0, 1);
      await utimes(join(dir, ".cortexdream-lock"), ancient, ancient);

      const before = Date.now();
      await releaseLock(dir, { recordConsolidation: true, priorMtimeMs: 0 });
      const st = await stat(join(dir, ".cortexdream-lock"));
      expect(st.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    });

    it("restores priorMtimeMs on recordConsolidation=false", async () => {
      const priorDate = new Date(2020, 5, 15);
      await writeFile(join(dir, ".cortexdream-lock"), "99999999");
      await utimes(join(dir, ".cortexdream-lock"), priorDate, priorDate);

      const lock = await acquireLock(dir, 60 * 60 * 1000);
      expect(lock.acquired).toBe(true);
      await releaseLock(dir, {
        recordConsolidation: false,
        priorMtimeMs: lock.priorMtimeMs,
      });

      const st = await stat(join(dir, ".cortexdream-lock"));
      expect(Math.abs(st.mtimeMs - priorDate.getTime())).toBeLessThan(5000);
    });

    it("never throws on a deleted lock file", async () => {
      await acquireLock(dir, 60_000);
      await rm(join(dir, ".cortexdream-lock"));
      await expect(
        releaseLock(dir, { recordConsolidation: true, priorMtimeMs: 0 }),
      ).resolves.toBeUndefined();
    });
  });

  describe("isPidAlive", () => {
    it("returns true for current process", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", () => {
      expect(isPidAlive(99999999)).toBe(false);
    });

    it("returns false for negative or zero PID", () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
    });
  });
});
