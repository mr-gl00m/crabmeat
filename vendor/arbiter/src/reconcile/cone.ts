import type { EffectClass, Intent } from "../types.js";

export interface ToolDef {
  readonly name: string;
  readonly effectClass: EffectClass;
  readonly required: readonly string[];
  readonly fromIntent: readonly string[];
  readonly fromLlm: readonly string[];
}

export const DEFAULT_TOOL_CATALOG: readonly ToolDef[] = [
  {
    name: "file_write",
    effectClass: "write",
    required: ["filename", "content"],
    fromIntent: ["filename"],
    fromLlm: ["content"],
  },
  {
    name: "file_read",
    effectClass: "read",
    required: ["filename"],
    fromIntent: ["filename"],
    fromLlm: [],
  },
  {
    name: "web_search",
    effectClass: "search",
    required: ["query"],
    fromIntent: ["query"],
    fromLlm: [],
  },
];

export function permissionCone(
  intent: Intent,
  catalog: readonly ToolDef[] = DEFAULT_TOOL_CATALOG,
): readonly ToolDef[] {
  return catalog.filter((t) => t.effectClass === intent.effectClass);
}
