import { ToolValidationError, EffectDeniedError } from "../../infra/errors.js";
import type { AgentConfig } from "../../config/types.js";
import {
  assertOwnerOnlyAccess,
  type CallerRole,
} from "../../security/owner-only-tools.js";
import type { ToolCatalog } from "./catalog.js";
import type {
  CapabilityMap,
  ToolInvocation,
  ValidatedInvocation,
  EffectClass,
} from "./types.js";
import { logger } from "../../infra/logger.js";

/**
 * Deterministic validation gate for tool invocations.
 * No AI, no heuristics — pure code checks.
 *
 * Steps:
 * 1. Resolve capability ID → tool ID
 * 2. Check tool is in agent's allowed list
 * 3. Check effect class is permitted
 * 4. Owner-only gate: non-owner callers cannot reach owner-only tools
 *    (defense in depth — catalog filtering already hides them)
 * 5. Validate parameters against Zod schema
 * 6. Return ValidatedInvocation or throw
 */
export function validateToolInvocation(
  invocation: ToolInvocation,
  agentConfig: AgentConfig,
  capMap: CapabilityMap,
  catalog: ToolCatalog,
  callerRole?: CallerRole,
): ValidatedInvocation {
  // 1. Resolve capability ID
  const toolId = catalog.resolveCapability(invocation.capabilityId, capMap);
  if (!toolId) {
    logger.warn(
      { capabilityId: invocation.capabilityId },
      "Unknown capability ID in tool invocation",
    );
    throw new ToolValidationError(
      `Unknown capability ID '${invocation.capabilityId}'`,
    );
  }

  // 2. Check tool is allowed for this agent
  if (!agentConfig.tools.includes(toolId)) {
    logger.warn(
      { toolId, agentId: agentConfig.id },
      "Tool not permitted for agent",
    );
    throw new EffectDeniedError(
      `Tool '${toolId}' is not permitted for this agent`,
    );
  }

  // 3. Look up tool definition and check effect class
  const toolDef = catalog.get(toolId);
  if (!toolDef) {
    throw new ToolValidationError(`Tool '${toolId}' not found in catalog`);
  }

  const allowedEffects = agentConfig.allowedEffects as EffectClass[];
  if (!allowedEffects.includes(toolDef.effectClass)) {
    logger.warn(
      {
        toolId,
        effectClass: toolDef.effectClass,
        allowedEffects,
      },
      "Effect class not permitted by agent config",
    );
    throw new EffectDeniedError(
      `Effect class '${toolDef.effectClass}' is not permitted. ` +
        `Allowed: [${allowedEffects.join(", ")}]`,
    );
  }

  // 4. Owner-only gate. Catalog filtering already hides these tools from
  // non-owner callers' declarations, so a well-behaved LLM never tries to
  // invoke one. This guard catches the case where a caller crafts a raw
  // capability ID. Throwing EffectDeniedError lets the inference loop's
  // existing deny path handle it cleanly: hard-stop the batch, record
  // resultStatus="denied", no retry spiral.
  if (toolDef.ownerOnly === true) {
    assertOwnerOnlyAccess({
      toolName: toolDef.id,
      callerRole: callerRole ?? "owner",
    });
  }

  // 5. Validate parameters against Zod schema
  const parseResult = toolDef.parameterSchema.safeParse(invocation.arguments);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    logger.warn(
      { toolId, issues },
      "Tool parameter validation failed",
    );
    throw new ToolValidationError(
      `Parameter validation failed for tool '${toolDef.name}': ${issues}`,
      parseResult.error.issues,
    );
  }

  // 6. Return validated invocation
  return {
    toolId: toolDef.id,
    toolName: toolDef.name,
    callId: invocation.callId,
    parameters: parseResult.data as Record<string, unknown>,
    effectClass: toolDef.effectClass,
  };
}
