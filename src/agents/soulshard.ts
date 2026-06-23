/**
 * Soulshard (.shard) file discovery, extraction, and parsing.
 *
 * A .shard file is a ZIP archive containing structured JSON bundles:
 *   manifest.json   — metadata + SHA-256 integrity checksums
 *   soulshard.json  — identity, personality, traits, boundaries
 *   mindshard.json  — tiered memory state (STM / LTM / Core)
 *   shellshard.json — physical profile (optional, not parsed in Tier 1)
 *   worldshard.json — environmental context (optional, not parsed in Tier 1)
 *
 * Discovery checks workspace root and .crabmeat/ for *.shard files.
 * The first found is loaded, manifest checksums verified, and the
 * soulshard + mindshard bundles parsed via Zod schemas.
 */

import { readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { z } from "zod";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";

// ── Zod Schemas ──────────────────────────────────────────

const manifestFileEntrySchema = z.union([
  z.string(),
  z.object({ filename: z.string(), type: z.string().optional() }),
]);

const manifestSchema = z.object({
  bundle_version: z.string().optional(),
  shard_name: z.string().optional(),
  files: z.array(manifestFileEntrySchema).optional(),
  checksums: z.record(z.string(), z.string()).optional(),
  session_counter: z.number().optional(),
}).passthrough();

const interactionDataSchema = z.object({
  interaction_model: z.string().optional(),
  obedience_model: z.string().optional(),
  can_refuse_commands: z.boolean().optional(),
}).optional();

const kinkDataSchema = z.object({
  content_boundaries: z.string().optional(),
  safe_words: z.array(z.string()).optional(),
  risk_flags: z.array(z.string()).optional(),
  nsfw_mode: z.string().optional(),
  preferred_speech_tone: z.string().optional(),
  speech_policy_mode: z.string().optional(),
}).optional();

const soulshardSchema = z.object({
  // Identity
  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  role: z.string().optional(),
  core_essence: z.string().optional(),
  eidolon_signature: z.string().optional(),

  // Personality
  personality: z.string().optional(),
  tone: z.string().optional(),
  trait_tags: z.array(z.string()).optional(),
  primary_motivation: z.string().optional(),

  // State
  current_status: z.object({
    emotion: z.string().optional(),
    echo_depth: z.union([z.number(), z.string()]).optional(),
  }).passthrough().optional(),

  // Stats (values are usually numbers but some entries like "Resonance" are strings)
  stat_block: z.record(z.string(), z.union([z.number(), z.string()])).optional(),

  // Behavior
  interaction_data: interactionDataSchema,

  // Boundaries
  kink_data: kinkDataSchema,

  // Evolution
  evolution_flags: z.object({
    can_evolve: z.boolean().optional(),
    evolves_from: z.string().optional(),
    evolves_into: z.string().optional(),
  }).optional(),
  haunting_tier: z.number().optional(),

  // Appearance (loaded but not actively used in Tier 1)
  appearance_profile: z.record(z.string(), z.unknown()).optional(),
}).passthrough(); // Allow additional fields we don't know about yet

const memoryEntrySchema = z.object({
  entry_title: z.string().optional(),
  the_moment: z.string().optional(),
  the_shift: z.string().optional(),
  the_truth: z.string().optional(),
  strength: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const coreMemorySchema = z.object({
  directive: z.string().optional(),
  trigger_tags: z.array(z.string()).optional(),
  strength: z.number().optional(),
  locked: z.boolean().optional(),
});

const mindshardSchema = z.object({
  short_term: z.object({
    max_slots: z.number().optional(),
    slots: z.array(memoryEntrySchema).optional(),
  }).optional(),
  long_term: z.object({
    max_slots: z.number().optional(),
    slots: z.array(memoryEntrySchema).optional(),
  }).optional(),
  core: z.array(coreMemorySchema).optional(),
  archive: z.array(memoryEntrySchema).optional(),
}).passthrough();

// ── Exported Types ───────────────────────────────────────

export type Manifest = z.infer<typeof manifestSchema>;
export type SoulshardData = z.infer<typeof soulshardSchema>;
export type MindshardData = z.infer<typeof mindshardSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type CoreMemory = z.infer<typeof coreMemorySchema>;

export interface ShardBundle {
  /** Path to the .shard file on disk. */
  path: string;
  /** Parsed manifest. */
  manifest: Manifest;
  /** Parsed soulshard identity/personality data. */
  soulshard: SoulshardData;
  /** Parsed mindshard memory data (null if not present in archive). */
  mindshard: MindshardData | null;
}

// ── Discovery ────────────────────────────────────────────

/**
 * Search for a .shard file in the workspace root and .crabmeat/ directory.
 * Returns the absolute path to the first found, or null.
 */
export async function discoverShardFile(workspaceRoot: string): Promise<string | null> {
  const searchDirs = [
    workspaceRoot,
    join(workspaceRoot, ".crabmeat"),
  ];

  for (const dir of searchDirs) {
    try {
      const entries = await readdir(dir);
      const shardFile = entries.find((e) => extname(e).toLowerCase() === ".shard");
      if (shardFile) {
        const fullPath = resolve(join(dir, shardFile));
        logger.info({ path: fullPath }, "Discovered .shard file");
        return fullPath;
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return null;
}

// ── Loading & Parsing ────────────────────────────────────

/**
 * Load and parse a .shard ZIP file. Verifies manifest checksums,
 * extracts soulshard.json and optionally mindshard.json.
 *
 * Throws on:
 * - ZIP read failure
 * - Missing soulshard.json
 * - Checksum mismatch (manifest tampering)
 * - JSON parse or schema validation failure
 */
// ── ZIP safety limits ────────────────────────────────────
const MAX_SHARD_ENTRIES = 50;
const MAX_SHARD_TOTAL_BYTES = 10 * 1024 * 1024;  // 10 MB decompressed
const MAX_SHARD_ENTRY_BYTES = 5 * 1024 * 1024;   // 5 MB per file
// Compressed-file precheck: stat() before adm-zip touches the bytes. Without
// this, a 50 MB compressed shard placed on disk (cloned repo, stray download)
// gets fully read into memory before the per-entry/decompressed-size guards
// engage, defeating those guards entirely. 50 MB is generous — a real shard
// is kilobytes — and the limit catches accidental gigabyte files too.
const MAX_SHARD_COMPRESSED_BYTES = 50 * 1024 * 1024;

export function loadShard(shardPath: string): ShardBundle {
  // Reject oversized compressed input before adm-zip allocates anything.
  // statSync is fine here: loadShard is already synchronous and runs at
  // startup or during shard discovery, both off the hot path.
  let compressedSize: number;
  try {
    compressedSize = statSync(shardPath).size;
  } catch (err) {
    throw new Error(
      `Shard ${shardPath}: cannot stat file (${formatErrorMessage(err)})`,
    );
  }
  if (compressedSize > MAX_SHARD_COMPRESSED_BYTES) {
    throw new Error(
      `Shard ${shardPath}: compressed size ${compressedSize} bytes exceeds cap ${MAX_SHARD_COMPRESSED_BYTES}`,
    );
  }

  const zip = new AdmZip(shardPath);
  const entries = zip.getEntries();

  // ZIP bomb protection: limit entry count
  if (entries.length > MAX_SHARD_ENTRIES) {
    throw new Error(
      `Shard ${shardPath}: too many entries (${entries.length}, max ${MAX_SHARD_ENTRIES})`,
    );
  }

  // Build a name → buffer map with size checks
  const fileMap = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Reject path traversal in entry names
    if (entry.entryName.includes("..") || entry.entryName.includes("\0")) {
      throw new Error(
        `Shard ${shardPath}: unsafe entry name '${entry.entryName}'`,
      );
    }

    const data = entry.getData();

    if (data.length > MAX_SHARD_ENTRY_BYTES) {
      throw new Error(
        `Shard ${shardPath}: entry '${entry.entryName}' too large ` +
        `(${data.length} bytes, max ${MAX_SHARD_ENTRY_BYTES})`,
      );
    }

    totalBytes += data.length;
    if (totalBytes > MAX_SHARD_TOTAL_BYTES) {
      throw new Error(
        `Shard ${shardPath}: total decompressed size exceeds ${MAX_SHARD_TOTAL_BYTES} bytes`,
      );
    }

    fileMap.set(entry.entryName, data);
  }

  // Parse manifest
  const manifestBuf = fileMap.get("manifest.json");
  if (!manifestBuf) {
    throw new Error(`Shard ${shardPath}: missing manifest.json`);
  }
  const manifest = manifestSchema.parse(JSON.parse(manifestBuf.toString("utf-8")));

  // Verify checksums — warn if absent (shard integrity cannot be verified)
  if (!manifest.checksums) {
    logger.warn(
      { shard: shardPath },
      "Shard manifest has no checksums — integrity unverified. Consider adding checksums.",
    );
  } else {
    for (const [filename, expectedHash] of Object.entries(manifest.checksums)) {
      const fileBuf = fileMap.get(filename);
      if (!fileBuf) {
        logger.warn({ filename, shard: shardPath }, "Checksum listed for missing file — skipping");
        continue;
      }
      const actual = createHash("sha256").update(fileBuf).digest("hex");
      if (actual !== expectedHash) {
        throw new Error(
          `Shard ${shardPath}: checksum mismatch for ${filename} ` +
          `(expected ${expectedHash.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
        );
      }
    }
    logger.info({ shard: shardPath }, "Manifest checksums verified");
  }

  // Parse soulshard.json (required)
  const soulshardBuf = fileMap.get("soulshard.json");
  if (!soulshardBuf) {
    throw new Error(`Shard ${shardPath}: missing soulshard.json`);
  }
  const soulshard = soulshardSchema.parse(JSON.parse(soulshardBuf.toString("utf-8")));

  // Parse mindshard.json or memoryshard.json (optional — name varies by shard version)
  let mindshard: MindshardData | null = null;
  const mindshardBuf = fileMap.get("mindshard.json") ?? fileMap.get("memoryshard.json");
  if (mindshardBuf) {
    mindshard = mindshardSchema.parse(JSON.parse(mindshardBuf.toString("utf-8")));
  }

  logger.info(
    {
      shard: shardPath,
      name: soulshard.name ?? manifest.shard_name ?? "unnamed",
      hasMindshard: mindshard !== null,
      traits: soulshard.trait_tags?.length ?? 0,
    },
    "Shard loaded successfully",
  );

  return { path: shardPath, manifest, soulshard, mindshard };
}
