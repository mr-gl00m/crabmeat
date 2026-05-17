/**
 * Skill discovery and loading.
 *
 * Scans .crabmeat/skills/<name>/SKILL.md files, parses frontmatter,
 * and returns SkillDefinition[].
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SkillDefinition, SkillMetadata } from "./types.js";

/**
 * Parse a SKILL.md file into metadata (from frontmatter) and instructions (body).
 * Frontmatter is delimited by --- lines and parsed as JSON-compatible key-value.
 */
export function parseSkillFile(content: string): { metadata: SkillMetadata; instructions: string } | null {
  const trimmed = content.trim();

  // Check for frontmatter (--- delimiters)
  if (!trimmed.startsWith("---")) {
    // No frontmatter — treat entire content as instructions with minimal metadata
    return {
      metadata: { name: "unnamed", description: "" },
      instructions: trimmed,
    };
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    // Malformed frontmatter
    return null;
  }

  const frontmatterRaw = trimmed.slice(3, endIdx).trim();
  const instructions = trimmed.slice(endIdx + 3).trim();

  // Parse frontmatter as simple key-value YAML-like syntax
  // Supports: key: "value", key: value, key: [a, b, c]
  try {
    const metadata = parseFrontmatter(frontmatterRaw);
    if (!metadata.name) metadata.name = "unnamed";
    if (!metadata.description) metadata.description = "";
    return { metadata: metadata as unknown as SkillMetadata, instructions };
  } catch (err) {
    logger.warn({ error: formatErrorMessage(err) }, "Failed to parse skill frontmatter");
    return null;
  }
}

/**
 * Simple frontmatter parser. Handles basic YAML-like syntax:
 * - key: value (strings, numbers, booleans)
 * - key: "quoted string"
 * - Nested objects via JSON inline
 *
 * For complex structures (tool definitions), we expect JSON format
 * wrapped in the frontmatter.
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  // Try parsing as JSON first (for complex frontmatter with tool definitions)
  try {
    // Wrap in braces if it looks like bare key-value pairs
    const asJson = raw.startsWith("{") ? raw : `{${raw.split("\n").map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return "";
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      // Quote the key, leave value as-is if it looks like JSON
      if (!key) return "";
      return `"${key}": ${value.startsWith("[") || value.startsWith("{") || value.startsWith('"') || value === "true" || value === "false" || !isNaN(Number(value)) ? value : `"${value}"`}`;
    }).filter(Boolean).join(",\n")}}`;

    return JSON.parse(asJson);
  } catch {
    // Fallback: simple line-by-line key: value parsing
    const result: Record<string, unknown> = {};
    for (const line of raw.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: string | unknown = line.slice(colonIdx + 1).trim();

      if (!key) continue;

      // Unquote strings
      if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }
    return result;
  }
}

/**
 * Validate a skill ID (directory name) for safety.
 */
function isSafeSkillId(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && !name.startsWith(".");
}

/**
 * Discover and load all skills from the skills directory.
 */
export async function discoverSkills(
  workspaceRoot: string,
  skillsDir: string = ".crabmeat/skills",
  maxSkillSize: number = 8_000,
): Promise<SkillDefinition[]> {
  const dir = join(workspaceRoot, skillsDir);
  const skills: SkillDefinition[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // Skills directory doesn't exist
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeSkillId(entry.name)) {
      logger.warn({ skillId: entry.name }, "Skipping skill with unsafe directory name");
      continue;
    }

    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");

    try {
      const fileStat = await stat(skillFile);
      if (!fileStat.isFile()) continue;

      const content = await readFile(skillFile, "utf-8");

      // Enforce size limit
      if (content.length > maxSkillSize) {
        logger.warn({ skillId: entry.name, size: content.length, max: maxSkillSize }, "Skill exceeds max size — skipping");
        continue;
      }

      const parsed = parseSkillFile(content);
      if (!parsed) {
        logger.warn({ skillId: entry.name }, "Failed to parse SKILL.md — skipping");
        continue;
      }

      skills.push({
        id: entry.name,
        metadata: parsed.metadata,
        instructions: parsed.instructions,
        path: skillDir,
      });

      logger.info({ skillId: entry.name, name: parsed.metadata.name }, "Discovered skill");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ skillId: entry.name, error: formatErrorMessage(err) }, "Error loading skill");
      }
    }
  }

  return skills;
}
