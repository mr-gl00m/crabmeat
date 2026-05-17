/**
 * Instruction file discovery for CrabMeat agents.
 *
 * Auto-discovers AGENT.md / .crabmeat/instructions.md files from the
 * workspace root up through ancestor directories, then injects their
 * content into the system prompt's dynamic section. This gives agents
 * declarative personality/domain knowledge without consuming
 * conversation turns.
 *
 * Supported files (checked per directory in the ancestor chain):
 *   AGENT.md          — primary agent instructions
 *   AGENT.local.md    — local overrides (gitignored)
 *   .crabmeat/AGENT.md
 *   .crabmeat/instructions.md
 *
 * Constraints:
 * - Per-file cap: 4 KB
 * - Total cap: 12 KB
 * - Deduplication by content hash
 * - Ancestor-first ordering (broadest scope first)
 */

import { readFile } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../infra/logger.js";

const MAX_INSTRUCTION_FILE_CHARS = 4_000;
const MAX_TOTAL_INSTRUCTION_CHARS = 12_000;

/** Filenames to look for in each directory. */
const CANDIDATE_NAMES = [
  "AGENT.md",
  "AGENT.local.md",
  join(".crabmeat", "AGENT.md"),
  join(".crabmeat", "instructions.md"),
];

export interface InstructionFile {
  /** Absolute path on disk. */
  path: string;
  /** Raw content (may be truncated). */
  content: string;
  /** Directory scope (relative to workspace root). */
  scope: string;
}

/**
 * Discover instruction files by walking from `startDir` up to the
 * filesystem root. Returns files ordered broadest-scope-first,
 * deduplicated by content.
 */
export async function discoverInstructionFiles(
  startDir: string,
): Promise<InstructionFile[]> {
  const directories: string[] = [];
  let cursor: string | null = resolve(startDir);

  // Collect ancestor chain (root → startDir)
  while (cursor) {
    directories.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break; // filesystem root
    cursor = parent;
  }

  const files: InstructionFile[] = [];
  const seenHashes = new Set<string>();

  for (const dir of directories) {
    for (const candidate of CANDIDATE_NAMES) {
      const fullPath = join(dir, candidate);
      try {
        const content = await readFile(fullPath, "utf-8");
        if (!content.trim()) continue;

        // Deduplicate by content hash
        const hash = createHash("sha256")
          .update(content.trim())
          .digest("hex")
          .slice(0, 16);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const scope = relative(startDir, dir) || ".";
        files.push({ path: fullPath, content, scope });
      } catch {
        // File doesn't exist or unreadable — skip silently
      }
    }
  }

  return files;
}

/**
 * Render discovered instruction files into a prompt section.
 * Applies per-file and total character budgets.
 */
export function renderInstructionSection(files: InstructionFile[]): string {
  if (files.length === 0) return "";

  const parts: string[] = ["# Workspace Instructions"];
  let remainingChars = MAX_TOTAL_INSTRUCTION_CHARS;

  for (const file of files) {
    if (remainingChars <= 0) {
      parts.push(
        "_Additional instruction content omitted — prompt budget reached._",
      );
      break;
    }

    const truncated = truncateContent(file.content, remainingChars);
    remainingChars -= truncated.length;

    const filename = relative(dirname(file.path), file.path);
    parts.push(`## ${filename} (scope: ${file.scope})`);
    parts.push(truncated);
  }

  logger.info(
    { fileCount: files.length, totalChars: MAX_TOTAL_INSTRUCTION_CHARS - remainingChars },
    "Instruction files loaded into system prompt",
  );

  return parts.join("\n\n");
}

function truncateContent(content: string, remaining: number): string {
  const limit = Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining);
  const trimmed = content.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit) + "\n\n[truncated]";
}
