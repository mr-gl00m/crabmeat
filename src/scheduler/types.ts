/**
 * Scheduler type definitions.
 */

export type ScheduleTrigger =
  | { type: "cron"; cron: string }
  | { type: "webhook"; path: string; secret?: string }
  | { type: "both"; cron: string; path: string; secret?: string };

export interface ScheduleDefinition {
  /** Unique identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Standard 5-field cron expression (minute hour dayOfMonth month dayOfWeek). */
  cron: string;
  /** The prompt to send to the agent when triggered. */
  prompt: string;
  /** Optional channel ID for routing. */
  channelId?: string;
  /** Optional peer ID for routing. */
  peerId?: string;
  /** Agent ID to route to (defaults to routing.defaultAgentId). */
  agentId?: string;
  /** File path (relative to workspace) to write results. */
  reportPath?: string;
  /**
   * Trigger configuration. When absent, the schedule uses the `cron` field
   * (backward compatible). When present, overrides triggering behavior.
   */
  trigger?: ScheduleTrigger;
  /** Whether this schedule is active. */
  enabled: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last execution (null if never run). */
  lastRunAt: string | null;
  /** ISO timestamp of next scheduled execution. */
  nextRunAt: string | null;
  /**
   * Outcome of the most recent execution. Null while the schedule has never
   * run. "ok" on clean completion, "error" when the pipeline threw or the
   * sink reported errors. Surfaced on list_schedules so failures are visible
   * without having to parse logs.
   */
  lastStatus?: "ok" | "error" | null;
  /** Error detail for the last run, or null on success. Pre-redacted. */
  lastError?: string | null;
}

export interface ScheduleResult {
  scheduleId: string;
  scheduleName: string;
  executedAt: string;
  /** Full text output from the pipeline. */
  output: string;
  /** Whether the pipeline encountered errors. */
  hadErrors: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
}
