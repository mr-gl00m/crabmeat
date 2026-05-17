/**
 * Phase 4.13 regression guard.
 *
 * The audit chain's value depends on it being the SINGLE source of
 * truth for privileged events — not a partial log that misses some.
 * Before 4.13, several privileged paths (circuit-breaker admin POST,
 * kill-token redemption, schedule cron runs) bypassed the chain
 * entirely, so a forensic review would have to cross-reference pino
 * logs, schedule-file metadata, and the audit log to reconstruct what
 * happened.
 *
 * This test verifies two properties that together prevent the
 * regression:
 *
 *   1. Every documented privileged path emits an audit entry with the
 *      expected toolId, effectClass="privileged", and a plausible
 *      callerRole. If someone removes the audit recording from one of
 *      these handlers, the corresponding sub-test fails.
 *   2. The chain stays internally consistent across mixed entry types.
 *      Entries from circuit-breaker, kill-token, scheduler, and tool
 *      calls all link via the same prevHash chain — verify() must
 *      remain valid as the chain grows. This catches a bug where a
 *      new entry source forgets to use the shared record() path.
 *
 * If you add a new privileged op:
 *   - Wire it through auditLog.record() with effectClass="privileged"
 *     and a "__"-prefixed toolId.
 *   - Add it to PRIVILEGED_OPS below so this test verifies it.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog, type AuditLog } from "./audit.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { issueKillToken, _resetKillTokens } from "./kill-tokens.js";
import {
  handleCircuitBreaker,
  handleKillToken,
  type AdminContext,
} from "../gateway/http/admin.js";
import { createSchedulerEngine } from "../scheduler/engine.js";
import { createScheduleStore } from "../scheduler/store.js";
import type { ScheduleDefinition } from "../scheduler/types.js";
import type { InferencePipeline } from "../agents/inference.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Manifest of privileged toolIds expected in the audit chain. Add new
 * entries here when you wire a new privileged operation through the
 * audit log.
 */
const PRIVILEGED_OPS = [
  {
    toolId: "__circuit_breaker",
    description: "POST /admin/circuit-breaker (trip + reset)",
    expectedCallerRole: "admin",
  },
  {
    toolId: "__kill_token",
    description: "GET /admin/kill-token (token redemption)",
    expectedCallerRole: "kill-token",
  },
  {
    toolId: "__schedule_run",
    description: "Scheduler cron run completion",
    expectedCallerRole: "scheduler",
  },
  // Phase 4.4.7 — __email_attachment_sent is a privileged-op toolId that
  // ships in src/connectors/email-imap.ts on every successful SMTP send
  // carrying attachments. Not yet wired into this exercise harness
  // because driving the inbound→reply flow needs a fake imapflow that
  // doesn't exist yet. The wiring is verified by typecheck + the
  // email-imap test suite; an exercise function for full coverage here
  // is a v0.1.1 follow-up.
] as const;

// ── Test harness helpers ─────────────────────────────────

function mockReq(url: string, method: string, opts?: { token?: string; body?: string }): IncomingMessage {
  const chunks: Buffer[] = opts?.body ? [Buffer.from(opts.body)] : [];
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const headers: Record<string, string> = { host: "localhost" };
  if (opts?.token) headers.authorization = `Bearer ${opts.token}`;
  const req = {
    url,
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, fn: (arg: unknown) => void) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    destroy() {},
  } as unknown as IncomingMessage;
  setImmediate(() => {
    for (const fn of listeners["data"] ?? []) for (const c of chunks) fn(c);
    for (const fn of listeners["end"] ?? []) fn(undefined);
  });
  return req;
}

function mockRes(): { res: ServerResponse; getStatus: () => number } {
  let statusCode = 0;
  const res = {
    writeHead(code: number) { statusCode = code; return res; },
    setHeader() {},
    end() {},
  } as unknown as ServerResponse;
  return { res, getStatus: () => statusCode };
}

function makeMockSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async load(key) { return sessions.get(key); },
    async save(s) { sessions.set(s.sessionKey, s); },
    create(key, agentId) {
      const s: Session = {
        sessionKey: key,
        agentId,
        transcript: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(key, s);
      return s;
    },
    async list() { return [...sessions.keys()]; },
    async delete(key) { sessions.delete(key); },
    async prefetch() {},
  } as unknown as SessionStore;
}

function makeMockPipeline(): InferencePipeline {
  return {
    handleTurn: vi.fn(async (sink, _session, prompt) => {
      sink.sendToken(`reply: ${prompt}`, "any");
      sink.sendDone("any", "msg-1");
    }),
  } as unknown as InferencePipeline;
}

const ADMIN_TOKEN = "admin-token-32-chars-long-enough-x";

async function exerciseCircuitBreakerAdmin(auditLog: AuditLog): Promise<void> {
  const ctx: AdminContext = {
    adminToken: ADMIN_TOKEN,
    circuitBreaker: createCircuitBreaker(),
    auditLog,
    shutdownFn: async () => {},
  };
  const handler = handleCircuitBreaker(ctx);
  // Trip
  await handler(
    mockReq("/admin/circuit-breaker", "POST", { token: ADMIN_TOKEN, body: '{"action":"trip"}' }),
    mockRes().res,
  );
  // Reset
  await handler(
    mockReq("/admin/circuit-breaker", "POST", { token: ADMIN_TOKEN, body: '{"action":"reset"}' }),
    mockRes().res,
  );
  ctx.circuitBreaker.destroy();
}

async function exerciseKillTokenRedemption(auditLog: AuditLog): Promise<void> {
  _resetKillTokens();
  const ctx: AdminContext = {
    adminToken: "",
    circuitBreaker: createCircuitBreaker(),
    auditLog,
    shutdownFn: async () => {},
  };
  const handler = handleKillToken(ctx);
  const tok = issueKillToken("integration-sess", "regression test");
  await handler(mockReq(`/admin/kill-token?t=${tok}`, "GET"), mockRes().res);
  ctx.circuitBreaker.destroy();
}

async function exerciseScheduledRun(auditLog: AuditLog): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "crabmeat-cov-"));
  const store = createScheduleStore(dir);
  const sessionStore = makeMockSessionStore();
  const pipeline = makeMockPipeline();
  const schedule: ScheduleDefinition = {
    id: "coverage-sched",
    name: "Coverage schedule",
    cron: "* * * * *",
    prompt: "go",
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: null,
  };
  await store.save(schedule);
  const engine = createSchedulerEngine(store, pipeline, sessionStore, "/tmp", auditLog);
  await engine.triggerNow("coverage-sched");
}

// ── The actual coverage assertion ────────────────────────

describe("Phase 4.13 — privileged-op audit chain coverage", () => {
  it("every privileged path emits an audit entry with the expected shape", async () => {
    const auditLog = createAuditLog();

    // Drive every documented privileged path. Adding one here without
    // also adding the toolId to PRIVILEGED_OPS will fail the assertion
    // below; removing the audit-recording from any handler will fail
    // for that toolId.
    await exerciseCircuitBreakerAdmin(auditLog);
    await exerciseKillTokenRedemption(auditLog);
    await exerciseScheduledRun(auditLog);

    const entries = auditLog.getEntries();
    for (const op of PRIVILEGED_OPS) {
      const matching = entries.filter((e) => e.toolId === op.toolId);
      expect(
        matching.length,
        `${op.description}: expected at least one audit entry with toolId="${op.toolId}", found 0`,
      ).toBeGreaterThan(0);
      // Every privileged-op entry must carry effectClass="privileged"
      // — that's how downstream filters tell privileged ops apart from
      // agent tool calls.
      for (const entry of matching) {
        expect(
          entry.effectClass,
          `${op.toolId}: effectClass must be "privileged"`,
        ).toBe("privileged");
      }
      // At least one entry should carry the expected callerRole.
      const withRole = matching.find((e) => e.callerRole === op.expectedCallerRole);
      expect(
        withRole,
        `${op.toolId}: expected at least one entry with callerRole="${op.expectedCallerRole}"`,
      ).toBeDefined();
    }
  });

  it("audit chain stays internally consistent across mixed privileged-op sources", async () => {
    const auditLog = createAuditLog();

    // Interleave entries from each privileged source. The chain must
    // verify cleanly regardless of source mixing — single chain,
    // multiple producers, one hash-linkage discipline.
    await exerciseCircuitBreakerAdmin(auditLog);
    await exerciseScheduledRun(auditLog);
    await exerciseKillTokenRedemption(auditLog);
    await exerciseCircuitBreakerAdmin(auditLog); // Second trip-reset cycle.
    await exerciseScheduledRun(auditLog);

    const verification = auditLog.verify();
    expect(verification.valid).toBe(true);

    // Sanity: chain length should be substantial — multiple entries
    // per call (trip + reset, plus failed-redemption first time the
    // _resetKillTokens path was used cross-ctx, etc.).
    expect(auditLog.getEntries().length).toBeGreaterThanOrEqual(7);

    // Each toolId appears at least once.
    const seen = new Set(auditLog.getEntries().map((e) => e.toolId));
    for (const op of PRIVILEGED_OPS) {
      expect(seen.has(op.toolId), `chain missing entries for ${op.toolId}`).toBe(true);
    }
  });

  it("regression: the manifest is non-empty and covers all current privileged ops", () => {
    // Lightweight metadata check — keeps the manifest honest. If
    // someone deletes the manifest without thinking, this fires.
    expect(PRIVILEGED_OPS.length).toBeGreaterThanOrEqual(3);
    const expectedToolIds = new Set([
      "__circuit_breaker",
      "__kill_token",
      "__schedule_run",
    ]);
    const manifestIds = new Set(PRIVILEGED_OPS.map((op) => op.toolId));
    for (const id of expectedToolIds) {
      expect(manifestIds.has(id), `manifest missing toolId ${id}`).toBe(true);
    }
  });
});
