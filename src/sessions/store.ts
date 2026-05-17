import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../infra/logger.js";
import { writeJsonAtomic, sweepAtomicTmpFiles } from "../infra/fs.js";
import type { SessionConfig } from "../config/types.js";
import type { Session } from "./types.js";

export interface SessionStore {
  load(sessionKey: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  create(sessionKey: string, agentId: string, channelId?: string, peerId?: string): Session;
  list(): Promise<string[]>;
  /**
   * Speculative read of the session file to warm OS page cache before
   * a real `load()` runs. Never throws, never returns the data — fire
   * and forget. Used by inbound connectors to overlap disk I/O with
   * other per-message work (parsing, validation).
   */
  prefetch(sessionKey: string): Promise<void>;
}

export function createSessionStore(config: SessionConfig): SessionStore {
  const dir = resolve(config.dir);
  let initialized = false;

  async function ensureDir(): Promise<void> {
    if (initialized) return;
    await mkdir(dir, { recursive: true });
    // Reap orphan atomic-write tempfiles from prior crashed runs. Safe
    // here because no save() has run yet in this process, so any tmp
    // we see is from a previous process and definitionally stale.
    const swept = await sweepAtomicTmpFiles(dir);
    if (swept > 0) {
      logger.debug({ dir, swept }, "sessions: removed orphan atomic-write tmp files");
    }
    initialized = true;
  }

  function filePath(sessionKey: string): string {
    // Hash the key to produce a safe, collision-resistant filename.
    // The old approach (stripping non-alnum chars) could collapse different
    // keys to the same filename (e.g. "session:a-b" and "sessionab").
    const safe = createHash("sha256").update(sessionKey).digest("hex");
    return join(dir, `${safe}.json`);
  }

  return {
    async load(sessionKey) {
      await ensureDir();
      try {
        const raw = await readFile(filePath(sessionKey), "utf-8");
        return JSON.parse(raw) as Session;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        logger.error({ err, sessionKey }, "Failed to load session");
        throw err;
      }
    },

    async save(session) {
      await ensureDir();
      session.updatedAt = new Date().toISOString();
      await writeJsonAtomic(filePath(session.sessionKey), session);
    },

    create(sessionKey, agentId, channelId?, peerId?) {
      const now = new Date().toISOString();
      return {
        sessionKey,
        agentId,
        channelId,
        peerId,
        transcript: [],
        createdAt: now,
        updatedAt: now,
      };
    },

    async list() {
      await ensureDir();
      const files = await readdir(dir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    },

    async prefetch(sessionKey) {
      // Read & discard. The OS page-caches the bytes, so the subsequent
      // load() — which actually parses JSON — hits cache instead of
      // physical disk. ENOENT is the normal "no session yet" path; any
      // other error is logged at debug only since this is fire-and-forget.
      try {
        await ensureDir();
        await readFile(filePath(sessionKey), "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        logger.debug({ err, sessionKey }, "session prefetch: non-fatal read error");
      }
    },
  };
}
