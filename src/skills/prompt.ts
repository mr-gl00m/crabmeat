/**
 * Skill prompt section builder.
 *
 * Renders discovered skills into a system prompt section for injection
 * alongside identity, notes, and task content.
 */

import type { SkillDefinition } from "./types.js";

/**
 * Build a system prompt section from loaded skills.
 * Applies a total character budget to prevent skills from consuming the context.
 */
export function buildSkillsPromptSection(
  skills: SkillDefinition[],
  maxTotalChars: number = 32_000,
): string {
  if (skills.length === 0) return "";

  const sections: string[] = [];
  let totalChars = 0;

  for (const skill of skills) {
    const section = `### ${skill.metadata.name}\n${skill.instructions}`;

    if (totalChars + section.length > maxTotalChars) {
      break; // Budget exhausted
    }

    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return "";

  return `[SKILLS]\nThe following skill modules are active:\n\n${sections.join("\n\n")}`;
}
