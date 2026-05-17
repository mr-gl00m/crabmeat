/**
 * Scheduler engine — checks schedules every 60 seconds and invokes
 * the inference pipeline via BufferSink for any that are due.
 *
 * Results are written to the schedule's reportPath (if configured)
 * and the schedule's lastRunAt/nextRunAt are updated.
 */

import { isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { InferencePipeline } from "../agents/inference.js";
import type { SessionStore } from "../sessions/store.js";
import type { AuditLog } from "../security/audit.js";
import type { ScheduleDefinition, ScheduleResult } from "./types.js";
import type { ScheduleStore } from "./store.js";
import { parseCron, cronMatches, nextCronMatch } from "./cron.js";
import { createBufferSink } from "../connectors/buffer-sink.js";
import { writeFileAtomic } from "../infra/fs.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";

const CHECK_INTERVAL_MS = 60_000; // 60 seconds

/** Pseudo-tool id used for scheduler-run audit entries. */
const PSEUDO_TOOL_SCHEDULE_RUN = "__schedule_run";

export type ReportPathResult =
  | { ok: true; absolute: string }
  | { ok: false; reason: string };

// Validate a schedule.reportPath before joining it with workspaceRoot.
// reportPath is a workspace-relative file path supplied by the agent (or
// by whoever wrote the schedule JSON). Without this gate, a traversal or
// absolute path lets a scheduled run write outside the workspace.
export function validateReportPath(
  reportPath: string,
  workspaceRoot: string,
): ReportPathResult {
  if (typeof reportPath !== "string" || reportPath.length === 0) {
    return { ok: false, reason: "reportPath must be a non-empty string" };
  }
  if (reportPath.includes("\0")) {
    return { ok: false, reason: "reportPath contains a null byte" };
  }
  if (isAbsolute(reportPath)) {
    return { ok: false, reason: "reportPath must be workspace-relative" };
  }
  // Catch UNC-style and POSIX-absolute inputs that path.isAbsolute may miss
  // when the runtime's path semantics don't match the input's intent.
  if (/^[\\/]{2}/.test(reportPath) || reportPath.startsWith("/")) {
    return { ok: false, reason: "reportPath must be workspace-relative" };
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, reportPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { ok: false, reason: "reportPath escapes workspace root" };
  }
  return { ok: true, absolute: candidate };
}

export interface SchedulerEngine {
  /** Start the scheduler tick loop. */
  start(): void;
  /** Stop the scheduler. */
  stop(): void;
  /** Manually trigger a schedule by ID (for testing / slash commands). */
  triggerNow(id: string): Promise<ScheduleResult | null>;
  /** Whether the engine is running. */
  readonly running: boolean;
}

export function createSchedulerEngine(
  scheduleStore: ScheduleStore,
  pipeline: InferencePipeline,
  sessionStore: SessionStore,
  workspaceRoot: string,
  /**
   * Optional audit log. When supplied, each completed schedule run
   * (success or error) records a privileged-op entry into the chain
   * alongside the existing schedule-file lastStatus / lastError
   * markers. Without this, schedule failures are scattered across
   * pino logs and per-schedule metadata — never in the canonical
   * security trail.
   */
  auditLog?: AuditLog,
): SchedulerEngine {
  let timer: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;
  /** Track which schedules are currently executing to prevent overlap. */
  const executing = new Set<string>();

  async function tick(): Promise<void> {
    const now = new Date();
    // Zero out seconds for minute-level matching
    now.setSeconds(0, 0);

    let schedules: ScheduleDefinition[];
    try {
      schedules = await scheduleStore.loadAll();
    } catch (err) {
      logger.error(
        { error: formatErrorMessage(err) },
        "Scheduler: failed to load schedules",
      );
      return;
    }

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      if (executing.has(schedule.id)) continue;

      try {
        const cron = parseCron(schedule.cron);
        if (!cronMatches(cron, now)) continue;

        // Don't re-run if already ran this minute
        if (schedule.lastRunAt) {
          const lastRun = new Date(schedule.lastRunAt);
          lastRun.setSeconds(0, 0);
          if (lastRun.getTime() === now.getTime()) continue;
        }

        // Execute asynchronously (don't block the tick loop)
        executing.add(schedule.id);
        void executeSchedule(schedule, now).finally(() => {
          executing.delete(schedule.id);
        });
      } catch (err) {
        logger.warn(
          { scheduleId: schedule.id, error: formatErrorMessage(err) },
          "Scheduler: error checking schedule",
        );
      }
    }
  }

  async function executeSchedule(
    schedule: ScheduleDefinition,
    triggeredAt: Date,
  ): Promise<ScheduleResult> {
    const startTime = Date.now();

    logger.info(
      { scheduleId: schedule.id, scheduleName: schedule.name },
      "Scheduler: executing schedule",
    );

    // Create or load the session for this schedule
    const sessionKey = `schedule:${schedule.id}`;
    let session = await sessionStore.load(sessionKey);
    if (!session) {
      session = sessionStore.create(
        sessionKey,
        schedule.agentId ?? "default",
        schedule.channelId,
        schedule.peerId,
      );
    }

    // Run inference via BufferSink
    const sink = createBufferSink();
    let pipelineThrew: string | null = null;
    try {
      await pipeline.handleTurn(sink, session, schedule.prompt, sessionStore);
    } catch (err) {
      pipelineThrew = formatErrorMessage(err);
      logger.error(
        { scheduleId: schedule.id, error: pipelineThrew },
        "Scheduler: pipeline error",
      );
    }

    const result = sink.getResult();
    const durationMs = Date.now() - startTime;
    const hadErrors = pipelineThrew !== null || result.errors.length > 0;

    const scheduleResult: ScheduleResult = {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      executedAt: triggeredAt.toISOString(),
      output: result.text,
      hadErrors,
      durationMs,
    };

    // Write report if configured. The reportPath is re-validated on every
    // run so a corrupted schedule file with a traversal/absolute path
    // can't escape the workspace, even though schedule_task already
    // rejects those at creation time.
    if (schedule.reportPath && result.text) {
      const validated = validateReportPath(schedule.reportPath, workspaceRoot);
      if (!validated.ok) {
        logger.warn(
          { scheduleId: schedule.id, reportPath: schedule.reportPath, reason: validated.reason },
          "Scheduler: refused to write report — invalid reportPath",
        );
      } else {
        try {
          const header = `# ${schedule.name} — ${triggeredAt.toISOString()}\n\n`;
          await writeFileAtomic(validated.absolute, header + result.text);

          logger.info(
            { scheduleId: schedule.id, reportPath: schedule.reportPath },
            "Scheduler: report written",
          );
        } catch (err) {
          logger.warn(
            { scheduleId: schedule.id, error: formatErrorMessage(err) },
            "Scheduler: failed to write report",
          );
        }
      }
    }

    // Update schedule metadata. lastStatus + lastError are persisted so
    // list_schedules can surface failures without having to grep logs.
    try {
      const cron = parseCron(schedule.cron);
      const next = nextCronMatch(cron, triggeredAt);

      schedule.lastRunAt = triggeredAt.toISOString();
      schedule.nextRunAt = next ? next.toISOString() : null;
      schedule.lastStatus = hadErrors ? "error" : "ok";
      schedule.lastError = hadErrors
        ? (pipelineThrew ?? result.errors[0]?.message ?? "pipeline reported error")
        : null;
      await scheduleStore.save(schedule);
    } catch (err) {
      logger.warn(
        { scheduleId: schedule.id, error: formatErrorMessage(err) },
        "Scheduler: failed to update schedule metadata",
      );
    }

    logger.info(
      {
        scheduleId: schedule.id,
        durationMs,
        outputLength: result.text.length,
        errors: result.errors.length,
      },
      "Scheduler: execution complete",
    );

    // Audit chain entry. Records the outcome of each cron run alongside
    // the per-schedule lastStatus/lastError already persisted to the
    // schedule file. The pseudo-tool pattern keeps these entries in the
    // same chain as agent tool calls — operators querying the audit
    // log don't need a second lookup path. Audit-record failure must
    // not crash the scheduler tick loop, so it's wrapped.
    if (auditLog) {
      try {
        auditLog.record({
          timestamp: triggeredAt.toISOString(),
          sessionKey: `schedule:${schedule.id}`,
          toolId: PSEUDO_TOOL_SCHEDULE_RUN,
          toolName: "schedule_run",
          effectClass: "privileged",
          callId: randomUUID(),
          parameters: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            cron: schedule.cron,
            outputChars: result.text.length,
            errorCount: result.errors.length,
            error: hadErrors
              ? (pipelineThrew ?? result.errors[0]?.message ?? "pipeline reported error")
              : null,
          },
          resultStatus: hadErrors ? "error" : "success",
          durationMs,
          callerRole: "scheduler",
        });
      } catch (err) {
        logger.warn(
          { scheduleId: schedule.id, error: formatErrorMessage(err) },
          "Scheduler: audit-record failed — run completed but audit chain has a gap",
        );
      }
    }

    return scheduleResult;
  }

  return {
    get running() {
      return isRunning;
    },

    start() {
      if (isRunning) return;
      isRunning = true;
      timer = setInterval(() => {
        void tick();
      }, CHECK_INTERVAL_MS);

      // Run first tick immediately
      void tick();
      logger.info("Scheduler engine started (60s interval)");
    },

    stop() {
      if (!isRunning) return;
      isRunning = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger.info("Scheduler engine stopped");
    },

    async triggerNow(id) {
      const schedule = await scheduleStore.load(id);
      if (!schedule) return null;

      executing.add(id);
      try {
        return await executeSchedule(schedule, new Date());
      } finally {
        executing.delete(id);
      }
    },
  };
}
