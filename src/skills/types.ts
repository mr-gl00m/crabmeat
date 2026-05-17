/**
 * Skill type definitions.
 *
 * A skill is a capability pack: a SKILL.md file in .crabmeat/skills/<name>/
 * that injects instructions into the agent's system prompt, with optional
 * tool definitions.
 */

import type { EffectClass } from "../agents/tools/types.js";
import type { ToolParameterConfig } from "../config/types.js";

/** Metadata parsed from SKILL.md frontmatter. */
export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tools?: SkillToolDefinition[];
  requiredEffects?: EffectClass[];
}

/** Tool definition embedded in a skill's frontmatter. */
export interface SkillToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, ToolParameterConfig>;
  effectClass: EffectClass;
  /** If set, maps to an existing registered handler. */
  handlerId?: string;
}

/** A fully loaded skill. */
export interface SkillDefinition {
  /** Directory name used as the skill ID. */
  id: string;
  /** Parsed metadata from frontmatter. */
  metadata: SkillMetadata;
  /** Raw SKILL.md content after frontmatter (the instructions). */
  instructions: string;
  /** Absolute path to the skill directory. */
  path: string;
}
