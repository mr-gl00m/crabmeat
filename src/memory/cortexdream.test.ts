import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGates,
  runCortexDreamIfDue,
  countRecentSessions,
  __resetCortexDreamProcessState,
  type CortexDreamConfig,
} from "./cortexdream.js";

function makeCfg(memoryDir: string, sessionsDir: string, overrides: Partial<CortexDreamConfig> = {}): CortexDreamConfig {
  return {
    enabled: true,
    memoryDir,
    sessionsDir,
    minHoursBetweenRuns: 24,
    minSessionsBetweenRuns: 5,
    throttleMs: 10 * 60 * 1000,
    lockStaleMs: 60 * 60 * 1000,
    ...overrides,
  };
}

describe("cortexdream", () => {
  let root: string;
  let memoryDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    __resetCortexDreamProcessState();
    root = await mkdtemp(join(tmpdir(), "crabmeat-cortexdream-"));
    memoryDir = join(root, "memory");
    sessionsDir = join(root, "sessions");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("countRecentSessions", () => {
    it("returns 0 for empty directory", async () => {
      expect(await countRecentSessions(sessionsDir, 0)).toBe(0);
    });

    it("returns 0 for missing directory", async () => {
      expect(await countRecentSessions(join(root, "nope"), 0)).toBe(0);
    });

    it("counts session files newer than the cutoff", async () => {
      await writeFile(join(sessionsDir, "a.json"), "{}");
      await writeFile(join(sessionsDir, "b.json"), "{}");
      const count = await countRecentSessions(sessionsDir, 0);
      expect(count).toBe(2);
    });

    it("excludes the current session by prefix match", async () => {
      await writeFile(join(sessionsDir, "current.json"), "{}");
      await writeFile(join(sessionsDir, "other.json"), "{}");
      const count = await countRecentSessions(sessionsDir, 0, "current");
      expect(count).toBe(1);
    });

    it("excludes files older than cutoff", async () => {
      await writeFile(join(sessionsDir, "ancient.json"), "{}");
      const ancient = new Date(2020, 0, 1);
      await utimes(join(sessionsDir, "ancient.json"), ancient, ancient);
      const cutoff = Date.now() - 1000;
      expect(await countRecentSessions(sessionsDir, cutoff)).toBe(0);
    });
  });

  describe("checkGates", () => {
    it("gate 0: rejects when disabled", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir, { enabled: false });
      const out = await checkGates(cfg);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.stage).toBe("enabled");
    });

    it("gate 4: rejects when not enough sessions", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      // Only 2 sessions — below the default threshold of 5
      for (let i = 0; i < 2; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      const out = await checkGates(cfg);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.stage).toBe("sessions");
    });

    it("passes all gates when conditions are met", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      const out = await checkGates(cfg);
      expect(out.ok).toBe(true);
    });

    it("gate 1: throttles repeated checks", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      const first = await checkGates(cfg);
      expect(first.ok).toBe(true);

      // Second call within throttle window — should be rejected
      const second = await checkGates(cfg);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.stage).toBe("throttle");
    });

    it("gate 2: rejects when last run was too recent", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      // Write a lock with a mtime 1h ago — under the 24h threshold
      await writeFile(join(memoryDir, ".cortexdream-lock"), String(process.pid));
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(join(memoryDir, ".cortexdream-lock"), oneHourAgo, oneHourAgo);

      const out = await checkGates(cfg);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.stage).toBe("time");
    });

    it("gate 2: passes when last run was long enough ago", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      // Write a lock with a mtime 30h ago — over the 24h threshold
      await writeFile(join(memoryDir, ".cortexdream-lock"), String(process.pid));
      const longAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
      await utimes(join(memoryDir, ".cortexdream-lock"), longAgo, longAgo);

      const out = await checkGates(cfg);
      expect(out.ok).toBe(true);
    });
  });

  describe("runCortexDreamIfDue", () => {
    it("does not run when gates fail", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir, { enabled: false });
      const result = await runCortexDreamIfDue(cfg);
      expect(result.ran).toBe(false);
    });

    it("runs end-to-end when gates pass and writes MEMORY.md", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      await writeFile(join(memoryDir, "topic1.md"), "# topic 1\nbody");
      await writeFile(join(memoryDir, "topic2.md"), "# topic 2\nbody");

      const result = await runCortexDreamIfDue(cfg);
      expect(result.ran).toBe(true);
      expect(result.summary?.filesScanned).toBe(2);

      const entrypoint = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
      expect(entrypoint).toContain("MEMORY index");
      expect(entrypoint).toContain("topic1");
      expect(entrypoint).toContain("topic2");
      expect(entrypoint).toContain("<!-- cortexdream:manifest-end -->");
    });

    it("preserves user content below the sentinel on re-run", async () => {
      const cfg = makeCfg(memoryDir, sessionsDir);
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      await writeFile(join(memoryDir, "topic1.md"), "# topic 1");

      // First run seeds the sentinel
      const first = await runCortexDreamIfDue(cfg);
      expect(first.ran).toBe(true);

      // User edits tail with a personal note
      const current = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
      const withNote = current + "\n## user section\n- important note\n";
      await writeFile(join(memoryDir, "MEMORY.md"), withNote);

      // Reset process state so the throttle gate doesn't block re-run,
      // and clear the lock so the time gate doesn't block
      __resetCortexDreamProcessState();
      await rm(join(memoryDir, ".cortexdream-lock"));

      const second = await runCortexDreamIfDue(cfg);
      expect(second.ran).toBe(true);

      const after = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
      expect(after).toContain("important note");
    });

    it("short-circuits when lock is held by another live pid", async () => {
      // Disable the time gate so the lock layer is what decides. A fresh
      // lock mtime would otherwise gate on time first ("0.0h ago — need
      // 24h") before we ever reach the lock check.
      const cfg = makeCfg(memoryDir, sessionsDir, {
        minHoursBetweenRuns: 0,
        minSessionsBetweenRuns: 0,
      });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(sessionsDir, `s${i}.json`), "{}");
      }
      // Write a lock held by the current PID (definitely alive) with a
      // fresh (but not future) mtime so it's not stale.
      await writeFile(join(memoryDir, ".cortexdream-lock"), String(process.pid));
      const oneSecondAgo = new Date(Date.now() - 1000);
      await utimes(join(memoryDir, ".cortexdream-lock"), oneSecondAgo, oneSecondAgo);

      const result = await runCortexDreamIfDue(cfg);
      expect(result.ran).toBe(false);
      if (!result.ran) expect(result.reason).toContain("lock");
    });
  });
});
