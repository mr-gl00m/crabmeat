/**
 * Scheduler tool handlers — let the agent create, list, and cancel
 * scheduled tasks.
 */

import { randomUUID } from "node:crypto";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { getWorkspaceRoot } from "./builtins.js";
import { createScheduleStore } from "../../scheduler/store.js";
import { validateCron, parseCron, nextCronMatch } from "../../scheduler/cron.js";
import { validateReportPath } from "../../scheduler/engine.js";
import type { ScheduleDefinition } from "../../scheduler/types.js";
import { logger } from "../../infra/logger.js";

type HandlerResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

// Lazy-init store (needs workspace root to be set first)
let _store: ReturnType<typeof createScheduleStore> | null = null;
function getStore() {
  if (!_store) _store = createScheduleStore(getWorkspaceRoot());
  return _store;
}

// ── schedule_task ───────────────────────────────────────

async function handleScheduleTask(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const name = params.name as string | undefined;
  const cron = params.cron as string | undefined;
  const prompt = params.prompt as string | undefined;

  if (!name || !cron || !prompt) {
    return {
      content: "Required parameters: name (string), cron (string), prompt (string).",
      isError: true,
    };
  }

  // Validate cron expression
  const cronError = validateCron(cron);
  if (cronError) {
    return {
      content: `Invalid cron expression '${cron}': ${cronError}\n\n` +
        "Format: minute hour dayOfMonth month dayOfWeek\n" +
        "Examples: '0 9 * * *' (daily 9am), '*/30 * * * *' (every 30 min), '0 0 * * 1' (Monday midnight)\n" +
        "Shortcuts: @daily, @hourly, @weekly, @monthly, @yearly",
      isError: true,
    };
  }

  // Validate reportPath at creation time so traversal/absolute paths are
  // rejected before they ever reach disk. The engine re-validates at
  // execute time too, in case a schedule JSON is hand-edited.
  const reportPathRaw = params.reportPath as string | undefined;
  if (reportPathRaw !== undefined) {
    const check = validateReportPath(reportPathRaw, getWorkspaceRoot());
    if (!check.ok) {
      return {
        content: `Invalid reportPath: ${check.reason}. reportPath must be a workspace-relative file path with no '..' segments.`,
        isError: true,
      };
    }
  }

  const store = getStore();

  // Generate ID from name
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    || randomUUID().slice(0, 8);

  // Check for duplicate
  const existing = await store.load(id);
  if (existing) {
    return {
      content: `A schedule named '${id}' already exists. Use cancel_schedule first, or choose a different name.`,
      isError: true,
    };
  }

  const now = new Date();
  const parsed = parseCron(cron);
  const next = nextCronMatch(parsed, now);

  const schedule: ScheduleDefinition = {
    id,
    name,
    cron,
    prompt,
    channelId: params.channelId as string | undefined,
    peerId: params.peerId as string | undefined,
    agentId: params.agentId as string | undefined,
    reportPath: reportPathRaw,
    enabled: true,
    createdAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: next ? next.toISOString() : null,
  };

  await store.save(schedule);

  logger.info({ scheduleId: id, cron, name }, "Schedule created by agent");

  const nextStr = next
    ? `Next run: ${next.toLocaleString()}`
    : "Could not determine next run time";

  return {
    content: `Schedule created:\n` +
      `  ID: ${id}\n` +
      `  Name: ${name}\n` +
      `  Cron: ${cron}\n` +
      `  Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"\n` +
      `  ${nextStr}`,
    outputs: {
      id,
      name,
      cron,
      next_run: next ? next.toISOString() : "",
    },
  };
}

// ── list_schedules ──────────────────────────────────────

async function handleListSchedules(
  _params: Record<string, unknown>,
): Promise<HandlerResult> {
  const store = getStore();
  const schedules = await store.loadAll();

  if (schedules.length === 0) {
    return {
      content: "No scheduled tasks. Use schedule_task to create one.",
      outputs: { schedules: [], count: 0 },
    };
  }

  const records = schedules.map((s) => ({
    id: s.id,
    name: s.name,
    cron: s.cron,
    enabled: s.enabled,
    last_run: s.lastRunAt ?? "",
    next_run: s.nextRunAt ?? "",
    last_status: s.lastStatus ?? "",
    last_error: s.lastError ?? "",
  }));

  const lines = schedules.map((s) => {
    const status = s.enabled ? "active" : "paused";
    const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never";
    const nextRun = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "unknown";
    const lastStatus = s.lastStatus
      ? (s.lastStatus === "error" ? ` — ERROR: ${(s.lastError ?? "").slice(0, 160)}` : " — ok")
      : "";
    return [
      `  **${s.name}** (${s.id}) [${status}]`,
      `    Cron: ${s.cron}`,
      `    Prompt: "${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? "..." : ""}"`,
      `    Last run: ${lastRun}${lastStatus} | Next: ${nextRun}`,
    ].join("\n");
  });

  return {
    content: `**Scheduled tasks (${schedules.length}):**\n\n${lines.join("\n\n")}`,
    outputs: { schedules: records, count: records.length },
  };
}

// ── cancel_schedule ─────────────────────────────────────

async function handleCancelSchedule(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const id = params.id as string | undefined;
  if (!id) {
    return { content: "Required parameter: id (string) — the schedule ID to cancel.", isError: true };
  }

  const store = getStore();
  const removed = await store.remove(id);

  if (!removed) {
    return {
      content: `Schedule '${id}' not found.`,
      isError: true,
      outputs: { id, cancelled: false },
    };
  }

  logger.info({ scheduleId: id }, "Schedule cancelled by agent");
  return {
    content: `Schedule '${id}' cancelled and removed.`,
    outputs: { id, cancelled: true },
  };
}

// ── Registration ────────────────────────────────────────

export function registerSchedulerTools(): void {
  registerToolHandler("schedule_task", handleScheduleTask);
  registerToolHandler("list_schedules", handleListSchedules);
  registerToolHandler("cancel_schedule", handleCancelSchedule);

  registerPromptFragment({
    id: "tool:scheduler",
    category: "tool",
    predicate: (ctx) =>
      ctx.tools.includes("schedule_task") ||
      ctx.tools.includes("list_schedules") ||
      ctx.tools.includes("cancel_schedule"),
    order: 60,
    content: [
      "SCHEDULING: You can create recurring tasks with schedule_task. When the",
      "user says 'do this daily' or 'remind me every Monday', create a schedule",
      "with the appropriate cron expression. Use list_schedules to show active",
      "schedules and cancel_schedule to remove them.",
    ].join("\n"),
  });

  logger.info(
    { tools: ["schedule_task", "list_schedules", "cancel_schedule"] },
    "Scheduler tool handlers registered",
  );
}
