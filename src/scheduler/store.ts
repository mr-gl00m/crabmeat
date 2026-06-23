/**
 * Schedule persistence — read/write schedule definitions to JSON files.
 *
 * Schedules are stored in .crabmeat/schedules/{id}.json.
 */

import { readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ScheduleDefinition } from "./types.js";
import { writeJsonAtomic } from "../infra/fs.js";
import { logger } from "../infra/logger.js";

export interface ScheduleStore {
  /** Load a schedule by ID. Returns null if not found. */
  load(id: string): Promise<ScheduleDefinition | null>;
  /** Save (create or update) a schedule. */
  save(schedule: ScheduleDefinition): Promise<void>;
  /** Delete a schedule by ID. Returns true if deleted. */
  remove(id: string): Promise<boolean>;
  /** List all schedule IDs. */
  list(): Promise<string[]>;
  /** Load all schedules. */
  loadAll(): Promise<ScheduleDefinition[]>;
}

export function createScheduleStore(workspaceRoot: string): ScheduleStore {
  const dir = join(workspaceRoot, ".crabmeat", "schedules");

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  function filePath(id: string): string {
    // Sanitize ID for filesystem safety
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(dir, `${safe}.json`);
  }

  return {
    async load(id) {
      try {
        const raw = await readFile(filePath(id), "utf-8");
        return JSON.parse(raw) as ScheduleDefinition;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        logger.warn({ id, error: (err as Error).message }, "Failed to load schedule");
        return null;
      }
    },

    async save(schedule) {
      await ensureDir();
      await writeJsonAtomic(filePath(schedule.id), schedule);
    },

    async remove(id) {
      try {
        await unlink(filePath(id));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },

    async list() {
      try {
        const entries = await readdir(dir);
        return entries
          .filter((e) => e.endsWith(".json"))
          .map((e) => e.replace(".json", ""));
      } catch {
        return [];
      }
    },

    async loadAll() {
      const ids = await this.list();
      const schedules: ScheduleDefinition[] = [];
      for (const id of ids) {
        const schedule = await this.load(id);
        if (schedule) schedules.push(schedule);
      }
      return schedules;
    },
  };
}
