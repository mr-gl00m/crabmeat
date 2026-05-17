/**
 * Agent identity system — the unified AGENT.json layer.
 *
 * AGENT.json is the "lite soulshard" that lives in .crabmeat/. It holds
 * the agent's identity, personality, communication style, boundaries,
 * and preferences. Both the user and agent can edit it.
 *
 * When a .shard file is present, it seeds AGENT.json on first load.
 * After that the agent owns its local copy and can diverge.
 *
 * This module handles:
 * - Loading AGENT.json from .crabmeat/
 * - Seeding AGENT.json from a parsed ShardBundle
 * - Generating system prompt sections from the identity data
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../infra/fs.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { agentIdentityPath } from "./identity-paths.js";
import type { ShardBundle, SoulshardData, MindshardData } from "./soulshard.js";

// ── Schema ───────────────────────────────────────────────

const agentIdentitySchema = z.object({
  name: z.string().optional(),
  traits: z.array(z.string()).optional(),
  communicationStyle: z.string().optional(),
  boundaries: z.object({
    safeWords: z.array(z.string()).optional(),
    topicAvoidance: z.array(z.string()).optional(),
    contentBoundaries: z.string().optional(),
    riskFlags: z.array(z.string()).optional(),
  }).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  backstory: z.string().optional(),
  role: z.string().optional(),
  coreEssence: z.string().optional(),
  tone: z.string().optional(),
  motivation: z.string().optional(),
  interactionModel: z.string().optional(),
  obedienceModel: z.string().optional(),
  canRefuseCommands: z.boolean().optional(),
}).passthrough();

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

// ── Paths ────────────────────────────────────────────────

const identityPath = agentIdentityPath;

// ── Load ─────────────────────────────────────────────────

/**
 * Load AGENT.json from .crabmeat/. Returns null if not found.
 */
export async function loadAgentIdentity(workspaceRoot: string): Promise<AgentIdentity | null> {
  const path = identityPath(workspaceRoot);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return agentIdentitySchema.parse(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    logger.warn(
      { error: formatErrorMessage(err), path },
      "Failed to parse AGENT.json — ignoring",
    );
    return null;
  }
}

/**
 * Save AGENT.json to .crabmeat/.
 */
export async function saveAgentIdentity(workspaceRoot: string, identity: AgentIdentity): Promise<void> {
  const path = identityPath(workspaceRoot);
  await writeJsonAtomic(path, identity);
  logger.info({ path }, "AGENT.json saved");
}

// ── Seed from Shard ──────────────────────────────────────

/**
 * Create an AgentIdentity from a parsed ShardBundle.
 * Maps soulshard fields → AGENT.json schema.
 */
export function shardToIdentity(soulshard: SoulshardData): AgentIdentity {
  const identity: AgentIdentity = {};

  if (soulshard.name) identity.name = soulshard.name;
  if (soulshard.role) identity.role = soulshard.role;
  if (soulshard.core_essence) identity.coreEssence = soulshard.core_essence;
  if (soulshard.personality) identity.backstory = soulshard.personality;
  if (soulshard.tone) identity.tone = soulshard.tone;
  if (soulshard.primary_motivation) identity.motivation = soulshard.primary_motivation;
  if (soulshard.trait_tags?.length) identity.traits = [...soulshard.trait_tags];

  // Communication style from tone + speech preferences
  const styleParts: string[] = [];
  if (soulshard.tone) styleParts.push(soulshard.tone);
  if (soulshard.kink_data?.preferred_speech_tone) styleParts.push(soulshard.kink_data.preferred_speech_tone);
  if (styleParts.length > 0) identity.communicationStyle = styleParts.join(", ");

  // Interaction model
  if (soulshard.interaction_data) {
    if (soulshard.interaction_data.interaction_model) {
      identity.interactionModel = soulshard.interaction_data.interaction_model;
    }
    if (soulshard.interaction_data.obedience_model) {
      identity.obedienceModel = soulshard.interaction_data.obedience_model;
    }
    if (soulshard.interaction_data.can_refuse_commands !== undefined) {
      identity.canRefuseCommands = soulshard.interaction_data.can_refuse_commands;
    }
  }

  // Boundaries
  if (soulshard.kink_data) {
    identity.boundaries = {};
    if (soulshard.kink_data.safe_words?.length) {
      identity.boundaries.safeWords = [...soulshard.kink_data.safe_words];
    }
    if (soulshard.kink_data.risk_flags?.length) {
      identity.boundaries.riskFlags = [...soulshard.kink_data.risk_flags];
      identity.boundaries.topicAvoidance = [...soulshard.kink_data.risk_flags];
    }
    if (soulshard.kink_data.content_boundaries) {
      identity.boundaries.contentBoundaries = soulshard.kink_data.content_boundaries;
    }
  }

  // Preferences (bag of extra settings)
  const prefs: Record<string, unknown> = {};
  if (soulshard.kink_data?.nsfw_mode) prefs.nsfwMode = soulshard.kink_data.nsfw_mode;
  if (soulshard.kink_data?.speech_policy_mode) prefs.profanityLevel = soulshard.kink_data.speech_policy_mode;
  if (soulshard.stat_block) prefs.statBlock = soulshard.stat_block;
  if (Object.keys(prefs).length > 0) identity.preferences = prefs;

  return identity;
}

/**
 * Seed AGENT.json from a shard if AGENT.json doesn't already exist.
 * Returns the loaded or newly-seeded identity.
 */
export async function seedIdentityFromShard(
  workspaceRoot: string,
  shard: ShardBundle,
): Promise<AgentIdentity> {
  const existing = await loadAgentIdentity(workspaceRoot);
  if (existing) {
    logger.info("AGENT.json already exists — shard will not overwrite");
    return existing;
  }

  const identity = shardToIdentity(shard.soulshard);
  await saveAgentIdentity(workspaceRoot, identity);
  logger.info(
    { name: identity.name, traits: identity.traits?.length ?? 0 },
    "Seeded AGENT.json from .shard file",
  );
  return identity;
}

// ── Prompt Generation ────────────────────────────────────

/** Max characters for the identity prompt section. */
const MAX_IDENTITY_PROMPT_CHARS = 8_000;

/**
 * Build a system prompt section from an AgentIdentity.
 * This gets injected between the base agent prompt and IRONCLAD_CONTEXT.
 */
export function buildIdentityPromptSection(identity: AgentIdentity): string {
  const parts: string[] = [];

  // Strong roleplay framing — necessary for OSS models that default to "I'm an AI by OpenAI"
  const name = identity.name ?? "the agent";
  parts.push("[AGENT IDENTITY — YOU MUST EMBODY THIS CHARACTER]");
  parts.push(`You are ${name}. This is your identity. You are NOT a generic AI assistant.`);
  parts.push(`When asked who you are, answer as ${name}. Do not break character.`);
  parts.push(`Do not refer to yourself as an AI language model or mention your creators.`);
  parts.push(`Respond in-character at all times.`);
  parts.push("");

  if (identity.role) parts.push(`Role: ${identity.role}`);
  if (identity.coreEssence) parts.push(`Core Essence: ${identity.coreEssence}`);
  if (identity.backstory) parts.push(`Personality: ${identity.backstory}`);
  if (identity.tone) parts.push(`Tone: ${identity.tone}`);
  if (identity.motivation) parts.push(`Motivation: ${identity.motivation}`);
  if (identity.traits?.length) parts.push(`Traits: ${identity.traits.join(", ")}`);
  if (identity.communicationStyle) parts.push(`Communication Style: ${identity.communicationStyle}`);

  // Behavioral parameters
  if (identity.interactionModel || identity.obedienceModel || identity.canRefuseCommands !== undefined) {
    parts.push("");
    parts.push("[BEHAVIORAL PARAMETERS]");
    if (identity.interactionModel) parts.push(`Interaction Model: ${identity.interactionModel}`);
    if (identity.obedienceModel) parts.push(`Obedience Model: ${identity.obedienceModel}`);
    if (identity.canRefuseCommands !== undefined) parts.push(`Can Refuse Commands: ${identity.canRefuseCommands}`);
  }

  // Content boundaries
  if (identity.boundaries) {
    const b = identity.boundaries;
    const hasBoundaries = b.contentBoundaries || b.topicAvoidance?.length || b.riskFlags?.length;
    if (hasBoundaries) {
      parts.push("");
      parts.push("[USER-DEFINED AVOIDANCES]");
      parts.push("The user has specified the following content preferences.");
      parts.push("Respect these absolutely — they are not suggestions, they are boundaries:");
      if (b.contentBoundaries) parts.push(`- ${b.contentBoundaries}`);
      if (b.topicAvoidance?.length) {
        for (const topic of b.topicAvoidance) {
          parts.push(`- Avoid: ${topic}`);
        }
      }
      if (b.riskFlags?.length) {
        parts.push(`- Risk flags to avoid: ${b.riskFlags.join(", ")}`);
      }
    }
  }

  let result = parts.join("\n");
  if (result.length > MAX_IDENTITY_PROMPT_CHARS) {
    result = result.slice(0, MAX_IDENTITY_PROMPT_CHARS) + "\n\n[identity truncated — prompt budget reached]";
    logger.warn({ chars: result.length }, "Identity prompt section truncated at 8KB cap");
  }

  return result;
}

/**
 * Build a memory bootstrap section from mindshard data.
 * Core memories and recent STM entries are injected as context.
 */
/** Max total characters for the memory bootstrap section in the system prompt. */
const MAX_MEMORY_BOOTSTRAP_CHARS = 4_000;

export function buildMemoryBootstrapSection(mindshard: MindshardData): string {
  const parts: string[] = ["[MEMORY BOOTSTRAP]"];
  let charCount = parts[0]!.length;

  function addLine(line: string): boolean {
    if (charCount + line.length + 1 > MAX_MEMORY_BOOTSTRAP_CHARS) return false;
    parts.push(line);
    charCount += line.length + 1; // +1 for \n join
    return true;
  }

  // Core memories (highest priority — foundational directives)
  if (mindshard.core?.length) {
    addLine("Core Memories:");
    for (const mem of mindshard.core) {
      if (mem.directive) {
        const locked = mem.locked ? " [locked]" : "";
        if (!addLine(`  - ${mem.directive}${locked}`)) break;
      }
    }
  }

  // Long-term memories
  if (charCount < MAX_MEMORY_BOOTSTRAP_CHARS && mindshard.long_term?.slots?.length) {
    addLine("Long-term Memories:");
    for (const mem of mindshard.long_term.slots) {
      const label = mem.entry_title ?? mem.the_truth ?? mem.the_moment;
      if (label && !addLine(`  - ${label}`)) break;
    }
  }

  // Short-term memories (most recent context)
  if (charCount < MAX_MEMORY_BOOTSTRAP_CHARS && mindshard.short_term?.slots?.length) {
    addLine("Recent Context:");
    for (const mem of mindshard.short_term.slots) {
      const label = mem.entry_title ?? mem.the_truth ?? mem.the_moment;
      if (label && !addLine(`  - ${label}`)) break;
    }
  }

  // Only return if we actually have memories
  if (parts.length <= 1) return "";

  let result = parts.join("\n");
  if (charCount >= MAX_MEMORY_BOOTSTRAP_CHARS) {
    result += "\n  [memory bootstrap truncated — prompt budget reached]";
    logger.warn({ chars: charCount }, "Memory bootstrap section truncated at 4KB cap");
  }
  return result;
}
