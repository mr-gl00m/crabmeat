/**
 * Pure TypeScript 5-field cron parser.
 *
 * Format: minute hour dayOfMonth month dayOfWeek
 *
 * Supports:
 *   *         any value
 *   5         exact value
 *   1,3,5     list
 *   1-5       range
 *   *​/15      step (every 15)
 *   1-30/5    range with step
 *
 * Day of week: 0-6 (Sunday=0) or 0-7 (Sunday=0 and 7)
 * Month: 1-12
 *
 * Shortcuts: @yearly @monthly @weekly @daily @hourly
 */

import { formatErrorMessage } from "../infra/errors.js";

// ── Field parsing ───────────────────────────────────────

interface CronField {
  values: Set<number>;
}

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // Step: */n or range/n
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = parseInt(stepStr!, 10);
      if (step <= 0) throw new Error(`Invalid step: ${stepStr}`);

      let rangeMin = min;
      let rangeMax = max;

      if (base !== "*") {
        const rangeParts = base!.split("-");
        if (rangeParts.length === 2) {
          rangeMin = parseInt(rangeParts[0]!, 10);
          rangeMax = parseInt(rangeParts[1]!, 10);
        } else {
          rangeMin = parseInt(base!, 10);
          rangeMax = max;
        }
        if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax)) {
          throw new Error(`Invalid step base: ${base}`);
        }
        if (rangeMin > rangeMax) {
          throw new Error(`Invalid range: ${base}`);
        }
      }

      for (let v = rangeMin; v <= rangeMax; v += step) {
        values.add(v);
      }
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }

    // Range: a-b
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (start > end) throw new Error(`Invalid range: ${trimmed}`);
      for (let v = start; v <= end; v++) values.add(v);
      continue;
    }

    // Exact value
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) throw new Error(`Invalid cron value: ${trimmed}`);
    values.add(num);
  }

  // Validate range
  for (const v of values) {
    if (v < min || v > max) {
      throw new Error(`Value ${v} out of range [${min}-${max}]`);
    }
  }

  return { values };
}

// ── Parsed cron expression ──────────────────────────────

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/**
 * Parse a 5-field cron expression string.
 * Throws on invalid syntax.
 */
export function parseCron(expression: string): CronExpression {
  const resolved = SHORTCUTS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = resolved.split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields (minute hour dayOfMonth month dayOfWeek), got ${parts.length}`,
    );
  }

  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 7), // 0 and 7 both = Sunday
  };
}

/**
 * Check if a Date matches a cron expression.
 */
export function cronMatches(cron: CronExpression, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  let dayOfWeek = date.getDay(); // 0 = Sunday

  if (!cron.minute.values.has(minute)) return false;
  if (!cron.hour.values.has(hour)) return false;
  if (!cron.dayOfMonth.values.has(dayOfMonth)) return false;
  if (!cron.month.values.has(month)) return false;

  // Day of week: 7 is also Sunday
  if (!cron.dayOfWeek.values.has(dayOfWeek) && !(dayOfWeek === 0 && cron.dayOfWeek.values.has(7))) {
    return false;
  }

  return true;
}

/**
 * Find the next Date that matches a cron expression after `after`.
 * Scans up to 366 days ahead. Returns null if no match found.
 */
export function nextCronMatch(cron: CronExpression, after: Date): Date | null {
  // Start from the next minute
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // ~1 year of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(cron, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Validate a cron expression string.
 * Returns null if valid, error message if invalid.
 */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return formatErrorMessage(err);
  }
}
