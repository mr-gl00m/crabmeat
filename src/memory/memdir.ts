// memdir — a tiered memory directory on top of CrabMeat's flat
// .crabmeat/memory/ key/value store: a single MEMORY.md entrypoint
// index + a population of individual memory files, with size/line
// caps on the entrypoint so it stays loadable into every turn's
// context window.
//
// The entrypoint is meant to be scanned *every* turn. The individual
// files are loaded on-demand (by the agent, via memory_read) or by
// the cortexDream consolidator when rewriting the index. This module
// is the read + scan + cap layer; cortexdream.ts drives the writes.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../infra/fs.js";
import { logger } from "../infra/logger.js";

/** Soft caps on the MEMORY.md entrypoint. Caps are warnings, not truncation. */
export const MEMDIR_ENTRYPOINT_MAX_LINES = 200;
export const MEMDIR_ENTRYPOINT_MAX_BYTES = 25 * 1024;

/**
 * Per-file metadata returned by `scanMemdir`. Kept deliberately
 * narrow — callers that want content load the file directly via
 * readFile. The manifest is what gets folded into a prompt, so it
 * should stay cheap to build and cheap to serialize.
 */
export interface MemdirHeader {
  /** File name without `.md` extension. Matches the memory_read/write key. */
  key: string;
  /** Absolute path on disk. */
  path: string;
  /** mtime as an ISO timestamp string. */
  mtime: string;
  /** Size in bytes on disk. */
  sizeBytes: number;
  /** First non-empty line (description hint). Undefined if file is empty. */
  description?: string;
}

/**
 * Scan a memory directory and return per-file headers, newest first.
 * Caps out at `maxFiles` entries (default 200) to match the upstream
 * pattern — scanning an unbounded directory each turn would be a
 * latency footgun.
 *
 * Missing directory is not an error: returns `[]` and the caller can
 * decide whether to create it. Hidden files (starting with `.`) and
 * the entrypoint itself are skipped.
 */
export async function scanMemdir(
  memoryDir: string,
  maxFiles = 200,
): Promise<MemdirHeader[]> {
  let entries: string[];
  try {
    entries = await readdir(memoryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const headers: MemdirHeader[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "MEMORY.md") continue;
    if (!name.endsWith(".md")) continue;

    const fullPath = join(memoryDir, name);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    // Pull the first non-empty line as a description hint. We read at
    // most 1KB — memory files can be large and we only want the lede.
    let description: string | undefined;
    try {
      const head = await readFile(fullPath, { encoding: "utf-8" });
      const firstLine = head.split("\n").find((l) => l.trim().length > 0);
      if (firstLine) description = firstLine.slice(0, 160);
    } catch {
      // best-effort — missing description is fine
    }

    headers.push({
      key: name.slice(0, -3),
      path: fullPath,
      mtime: st.mtime.toISOString(),
      sizeBytes: st.size,
      description,
    });
  }

  headers.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return headers.slice(0, maxFiles);
}

/**
 * Read the MEMORY.md entrypoint. Returns `undefined` if it does not
 * exist yet — a brand-new workspace has no index.
 */
export async function readEntrypoint(memoryDir: string): Promise<string | undefined> {
  const path = join(memoryDir, "MEMORY.md");
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export interface EntrypointCapReport {
  lines: number;
  bytes: number;
  overLineCap: boolean;
  overByteCap: boolean;
  /** Suggestion string for the log, or undefined if within caps. */
  warning?: string;
}

/**
 * Measure the entrypoint against the soft caps. Returns a report —
 * the caller decides what to do with an over-cap file (log, refuse
 * write, schedule a consolidation, etc). We never truncate here;
 * truncation is cortexDream's job so a user edit isn't clobbered.
 */
export function measureEntrypoint(content: string): EntrypointCapReport {
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf-8");
  const overLineCap = lines > MEMDIR_ENTRYPOINT_MAX_LINES;
  const overByteCap = bytes > MEMDIR_ENTRYPOINT_MAX_BYTES;
  let warning: string | undefined;
  if (overLineCap && overByteCap) {
    warning = `MEMORY.md is over both caps (${lines}/${MEMDIR_ENTRYPOINT_MAX_LINES} lines, ${bytes}/${MEMDIR_ENTRYPOINT_MAX_BYTES} bytes)`;
  } else if (overLineCap) {
    warning = `MEMORY.md is over the line cap (${lines}/${MEMDIR_ENTRYPOINT_MAX_LINES})`;
  } else if (overByteCap) {
    warning = `MEMORY.md is over the byte cap (${bytes}/${MEMDIR_ENTRYPOINT_MAX_BYTES})`;
  }
  return { lines, bytes, overLineCap, overByteCap, warning };
}

/**
 * Write a new entrypoint. Creates the memdir if it does not exist.
 * Logs a warning if the incoming content is already over cap, but
 * writes it anyway — the caller (cortexDream) is responsible for
 * producing cap-compliant content. We do not refuse a user edit.
 */
export async function writeEntrypoint(
  memoryDir: string,
  content: string,
): Promise<EntrypointCapReport> {
  const report = measureEntrypoint(content);
  if (report.warning) {
    logger.warn({ memoryDir, ...report }, `memdir: ${report.warning}`);
  }
  await writeFileAtomic(join(memoryDir, "MEMORY.md"), content);
  return report;
}

/**
 * Build a compact one-line-per-file manifest from scan headers, for
 * use in consolidation prompts. Keeps each row under ~200 chars so
 * a 200-file manifest stays well under the entrypoint cap.
 */
export function formatManifest(headers: readonly MemdirHeader[]): string {
  return headers
    .map((h) => {
      const desc = h.description ? ` — ${h.description}` : "";
      return `- ${h.key} (${h.mtime.slice(0, 10)}, ${h.sizeBytes}B)${desc}`;
    })
    .join("\n");
}
