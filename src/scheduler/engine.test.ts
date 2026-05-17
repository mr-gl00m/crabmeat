/**
 * Scheduler engine tests — focused on the audit-chain coverage added in
 * Phase 4.13. Full pipeline + cron + report-write coverage is left to
 * integration tests; these verify the privileged-op recording path that
 * the rest of the audit chain depends on.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSchedulerEngine, validateReportPath } from "./engine.js";
import { createScheduleStore } from "./store.js";
import { createAuditLog } from "../security/audit.js";
import type { ScheduleDefinition } from "./types.js";
import type { InferencePipeline } from "../agents/inference.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";

function makeMockSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async load(key) { return sessions.get(key); },
    async save(s) { sessions.set(s.sessionKey, s); },
    create(key, agentId, channelId, peerId) {
      const s: Session = {
        sessionKey: key,
        agentId,
        transcript: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(channelId ? { channelId } : {}),
        ...(peerId ? { peerId } : {}),
      };
      sessions.set(key, s);
      return s;
    },
    async list() { return [...sessions.keys()]; },
    async delete(key) { sessions.delete(key); },
    async prefetch() {},
  } as unknown as SessionStore;
}

function makeMockPipeline(opts: { throws?: boolean } = {}): InferencePipeline {
  return {
    handleTurn: vi.fn(async (sink, _session, prompt) => {
      if (opts.throws) {
        throw new Error("pipeline boom");
      }
      sink.sendToken(`reply to: ${prompt}`, "any");
      sink.sendDone("any", "msg-1");
    }),
  } as unknown as InferencePipeline;
}

async function makeScheduleStore() {
  const dir = mkdtempSync(join(tmpdir(), "crabmeat-sched-"));
  const store = createScheduleStore(dir);
  return { store, dir };
}

const BASE_SCHEDULE: Omit<ScheduleDefinition, "id"> = {
  name: "Test schedule",
  cron: "* * * * *",
  prompt: "say hi",
  enabled: true,
  createdAt: new Date().toISOString(),
  lastRunAt: null,
  nextRunAt: null,
};

describe("schedulerEngine audit chain coverage", () => {
  it("records a privileged-op audit entry on successful triggerNow run", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const auditLog = createAuditLog();
    const pipeline = makeMockPipeline();

    const schedule: ScheduleDefinition = { id: "test-sched-1", ...BASE_SCHEDULE };
    await store.save(schedule);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, "/tmp", auditLog);
    const result = await engine.triggerNow("test-sched-1");
    expect(result).not.toBe(null);
    expect(result!.hadErrors).toBe(false);

    const entries = auditLog.getEntries();
    const runEntry = entries.find((e) => e.toolId === "__schedule_run");
    expect(runEntry).toBeDefined();
    expect(runEntry!.toolName).toBe("schedule_run");
    expect(runEntry!.effectClass).toBe("privileged");
    expect(runEntry!.resultStatus).toBe("success");
    expect(runEntry!.callerRole).toBe("scheduler");
    expect(runEntry!.sessionKey).toBe("schedule:test-sched-1");
    expect(runEntry!.parameters.scheduleId).toBe("test-sched-1");
    expect(runEntry!.parameters.scheduleName).toBe("Test schedule");
    expect(runEntry!.parameters.error).toBe(null);
  });

  it("records resultStatus=error when the pipeline throws", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const auditLog = createAuditLog();
    const pipeline = makeMockPipeline({ throws: true });

    const schedule: ScheduleDefinition = { id: "test-sched-fail", ...BASE_SCHEDULE };
    await store.save(schedule);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, "/tmp", auditLog);
    const result = await engine.triggerNow("test-sched-fail");
    expect(result).not.toBe(null);
    expect(result!.hadErrors).toBe(true);

    const entries = auditLog.getEntries();
    const runEntry = entries.find((e) => e.toolId === "__schedule_run");
    expect(runEntry).toBeDefined();
    expect(runEntry!.resultStatus).toBe("error");
    expect(runEntry!.parameters.error).toBeTruthy();
    expect(String(runEntry!.parameters.error)).toContain("pipeline boom");
  });

  it("does not record audit entries when no auditLog is provided (back-compat)", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const pipeline = makeMockPipeline();

    const schedule: ScheduleDefinition = { id: "no-audit", ...BASE_SCHEDULE };
    await store.save(schedule);

    // Pipeline still runs, schedule metadata still updates — the audit
    // path is opt-in via the parameter so callers (e.g. test fixtures)
    // can omit it without surprise.
    const engine = createSchedulerEngine(store, pipeline, sessionStore, "/tmp");
    const result = await engine.triggerNow("no-audit");
    expect(result).not.toBe(null);
    expect(result!.hadErrors).toBe(false);
  });

  it("rejects a traversal reportPath at execute time and writes nothing outside the jail (RT-2026-05-01-001)", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const pipeline = makeMockPipeline();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "crabmeat-ws-"));

    // Bypass tool-side validation by writing the schedule directly through
    // the store, the same way an attacker who already corrupted
    // .crabmeat/schedules/<id>.json would. The engine must defend itself
    // even when the on-disk schedule contains a hostile reportPath.
    const schedule: ScheduleDefinition = {
      id: "traversal",
      ...BASE_SCHEDULE,
      reportPath: "..\\..\\..\\outside-crabmeat.md",
    };
    await store.save(schedule);

    // Pre-clean any leftover from a prior failing run so the assertion is
    // self-contained (the escape target is deterministic across runs).
    const escapedFile = resolve(workspaceRoot, "..\\..\\..\\outside-crabmeat.md");
    if (existsSync(escapedFile)) unlinkSync(escapedFile);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, workspaceRoot);
    const result = await engine.triggerNow("traversal");
    expect(result).not.toBe(null);

    // The escaping path is computed by joining workspaceRoot with the
    // traversal — that's exactly the location the pre-fix code would
    // have written to. After the fix, this file must not exist.
    expect(existsSync(escapedFile)).toBe(false);
  });

  it("rejects an absolute reportPath at execute time", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const pipeline = makeMockPipeline();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "crabmeat-ws-"));
    const absTarget = mkdtempSync(join(tmpdir(), "crabmeat-out-"));
    const escapedFile = join(absTarget, "owned.md");

    const schedule: ScheduleDefinition = {
      id: "absolute",
      ...BASE_SCHEDULE,
      reportPath: escapedFile,
    };
    await store.save(schedule);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, workspaceRoot);
    await engine.triggerNow("absolute");

    expect(existsSync(escapedFile)).toBe(false);
  });

  it("writes a valid reportPath atomically inside the workspace", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const pipeline = makeMockPipeline();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "crabmeat-ws-"));

    const schedule: ScheduleDefinition = {
      id: "valid-report",
      ...BASE_SCHEDULE,
      reportPath: "reports/run.md",
    };
    await store.save(schedule);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, workspaceRoot);
    await engine.triggerNow("valid-report");

    const reportFile = join(workspaceRoot, "reports", "run.md");
    expect(existsSync(reportFile)).toBe(true);
    const body = readFileSync(reportFile, "utf-8");
    expect(body).toContain("Test schedule");
    expect(body).toContain("reply to: say hi");
  });

  it("validateReportPath rejects traversal, absolute, UNC, and null-byte inputs", () => {
    const ws = mkdtempSync(join(tmpdir(), "crabmeat-vrp-"));

    const traversal = validateReportPath("..\\..\\escape.md", ws);
    expect(traversal.ok).toBe(false);

    const traversal2 = validateReportPath("../escape.md", ws);
    expect(traversal2.ok).toBe(false);

    const absolute = validateReportPath("C:\\Windows\\evil.md", ws);
    expect(absolute.ok).toBe(false);

    const posixAbs = validateReportPath("/etc/passwd", ws);
    expect(posixAbs.ok).toBe(false);

    const unc = validateReportPath("\\\\server\\share\\file.md", ws);
    expect(unc.ok).toBe(false);

    const nullByte = validateReportPath(`reports/run${String.fromCharCode(0)}.md`, ws);
    expect(nullByte.ok).toBe(false);

    const empty = validateReportPath("", ws);
    expect(empty.ok).toBe(false);

    const ok = validateReportPath("reports/run.md", ws);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.absolute.startsWith(resolve(ws))).toBe(true);
    }
  });

  it("survives an audit-record failure without crashing the run", async () => {
    const { store } = await makeScheduleStore();
    const sessionStore = makeMockSessionStore();
    const pipeline = makeMockPipeline();

    // Audit log that throws on record. The run must still complete and
    // schedule metadata must still update — audit failure is not allowed
    // to take down the scheduler tick loop.
    const auditLog = {
      record: vi.fn(() => { throw new Error("audit broken"); }),
      verify: vi.fn(() => ({ valid: true })),
      getEntries: vi.fn(() => []),
      flush: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({
        persistEnabled: false,
        pendingWrites: 0,
        totalEntries: 0,
        lastFlushAt: null,
        lastFlushOk: null,
        lastFlushError: null,
      })),
      length: 0,
    } as unknown as Parameters<typeof createSchedulerEngine>[4];

    const schedule: ScheduleDefinition = { id: "audit-broken", ...BASE_SCHEDULE };
    await store.save(schedule);

    const engine = createSchedulerEngine(store, pipeline, sessionStore, "/tmp", auditLog);
    const result = await engine.triggerNow("audit-broken");
    expect(result).not.toBe(null);
    expect(result!.hadErrors).toBe(false);
  });
});
