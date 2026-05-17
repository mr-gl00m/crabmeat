import { join } from "node:path";

/**
 * Single source of truth for the AGENT.json file path. Both
 * agents/agent-identity.ts (load/seed/save) and agents/tools/agent-data.ts
 * (the identity_read/identity_update tool handlers) resolve this path —
 * the helper here keeps the layout decision in one place so a future
 * relocation (e.g., to .crabmeat/agents/<id>/AGENT.json for multi-agent)
 * doesn't have to land in two files in lockstep.
 */
export function agentIdentityPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".crabmeat", "AGENT.json");
}
