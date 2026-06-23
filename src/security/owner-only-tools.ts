import { EffectDeniedError } from "../infra/errors.js";

/**
 * Caller-role identity for trust gating. Established at session creation:
 * direct CLI / WS = "owner"; future Hermes UI = "shell"; future webhook
 * inbound = "external". Email inbound is "owner" only when the From address
 * matches the connector's allowFromAddresses list (the existing security
 * boundary), otherwise the message never reaches inference.
 */
export type CallerRole = "owner" | "shell" | "external";

/**
 * Tools that mutate config, restart the gateway, or otherwise need owner
 * trust. The registry exists so:
 *  - Future tools can opt in by adding their canonical id here.
 *  - Hermes ("shell") and webhook ("external") roles arriving in later
 *    phases land into a routing pattern that's already wired and tested.
 *
 * The check is on the canonical tool id (the `name`/`id` field on
 * ToolDefinition), not the per-session capability id.
 *
 * launch_app: opens arbitrary installed desktop applications on the
 * operator's machine. An inbound email sender (even an allowlisted one
 * acting under a spoofed/compromised account) must never be able to pop
 * windows on the desktop. Only the person at the keyboard gets this.
 */
export const OWNER_ONLY_TOOL_NAMES = ["launch_app"] as const satisfies readonly string[];

const OWNER_ONLY_TOOL_NAME_SET: ReadonlySet<string> = new Set(OWNER_ONLY_TOOL_NAMES);

export function isOwnerOnlyToolName(toolName: string): boolean {
  return OWNER_ONLY_TOOL_NAME_SET.has(toolName);
}

/**
 * Config dot-paths an agent-side tool is allowed to mutate. Anything
 * outside this allowlist is rejected before the write RPC. Glob syntax:
 * `*` matches a single segment, `[]` means a keyed-array entry.
 *
 * Currently empty: no agent-facing config-write tool exists. When one
 * lands (gateway-equivalent, layer2 tuning, etc.), add the narrow paths
 * the agent should be able to tune. Auth tokens, secrets, and any
 * security primitive (kill-tokens, rate-limiters) must stay off this list.
 */
export const ALLOWED_OWNER_TOOL_CONFIG_PATHS = [] as const satisfies readonly string[];

const ALLOWED_PATH_PATTERNS: readonly string[] = ALLOWED_OWNER_TOOL_CONFIG_PATHS;

function pathSegmentMatches(patternSegment: string, pathSegment: string): boolean {
  return patternSegment === "*" || patternSegment === pathSegment;
}

/**
 * Test a config dot-path against the allowlist patterns. Used by future
 * config-mutating tools before they call the underlying write.
 */
export function isAllowedOwnerToolConfigPath(path: string): boolean {
  const pathSegments = path.split(".");
  return ALLOWED_PATH_PATTERNS.some((pattern) => {
    const patternSegments = pattern.split(".");
    if (patternSegments.length > pathSegments.length) {
      return false;
    }
    for (let i = 0; i < patternSegments.length; i += 1) {
      if (!pathSegmentMatches(patternSegments[i]!, pathSegments[i]!)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Throw if `callerRole` is not "owner". Precondition: the caller has
 * already established that the tool is owner-gated (e.g. via the
 * ToolDefinition.ownerOnly flag set at catalog construction time, or via
 * isOwnerOnlyToolName for static checks).
 *
 * Throwing `EffectDeniedError` keeps the existing inference loop's deny
 * path intact: hard-stop the batch, audit-log resultStatus="denied", no
 * retry spiral. Error message is deterministic per (tool, role) so the
 * loop's repeat-error signature tracking trips correctly if the LLM
 * insists on re-trying.
 */
export function assertOwnerOnlyAccess(params: {
  toolName: string;
  callerRole: CallerRole;
}): void {
  if (params.callerRole === "owner") return;
  throw new EffectDeniedError(
    `Tool '${params.toolName}' is owner-only and cannot be invoked by callerRole '${params.callerRole}'`,
  );
}
