/**
 * Trust gate — enforces connector trust level against tool effect
 * classes during validation.
 *
 * The escalation manager handles *runtime* elevation (user grants).
 * This module provides the *static* gate: given a ConnectorTrustLevel
 * and a requested EffectClass, should the call proceed, need
 * escalation, or be hard-denied?
 */

import type { ConnectorTrustLevel } from "../connectors/types.js";
import type { EffectClass } from "../agents/tools/types.js";
import {
  getEscalationManager,
  trustLevelAllows,
  minimumTrustForEffect,
} from "./escalation.js";
import type { ConnectorSink } from "../connectors/types.js";
import { logger } from "../infra/logger.js";

// ── Types ───────────────────────────────────────────────────

export type TrustGateVerdict =
  | { action: "allow" }
  | { action: "escalate"; requiredLevel: ConnectorTrustLevel }
  | { action: "deny"; reason: string };

// ── Static check (no escalation attempt) ────────────────────

/**
 * Check whether a trust level permits a given effect class.
 * Does not consult escalation state — pure policy check.
 */
export function checkTrustGate(
  trustLevel: ConnectorTrustLevel,
  effectClass: EffectClass,
): TrustGateVerdict {
  if (trustLevelAllows(trustLevel, effectClass)) {
    return { action: "allow" };
  }
  return {
    action: "escalate",
    requiredLevel: minimumTrustForEffect(effectClass),
  };
}

// ── Full gate (with escalation manager) ─────────────────────

/**
 * Evaluate whether a tool invocation should proceed, considering
 * both the connector's base trust level and any runtime escalations.
 *
 * Returns "allow" if the effective level (base + escalations) permits
 * the effect. Otherwise attempts interactive escalation via the sink.
 * Returns "deny" if escalation is not available or the user declines.
 */
export async function enforceTrustGate(
  sessionKey: string,
  baseTrustLevel: ConnectorTrustLevel,
  effectClass: EffectClass,
  toolName: string,
  sink: ConnectorSink,
): Promise<TrustGateVerdict> {
  const mgr = getEscalationManager();
  const effectiveLevel = mgr.getEffectiveLevel(sessionKey, baseTrustLevel);

  // Fast path: already permitted
  if (trustLevelAllows(effectiveLevel, effectClass)) {
    return { action: "allow" };
  }

  const requiredLevel = minimumTrustForEffect(effectClass);

  // Attempt interactive escalation if the sink supports it
  if (sink.requestPermission) {
    const reason = `Tool "${toolName}" requires ${effectClass} effect (needs ${requiredLevel} trust, current: ${effectiveLevel})`;
    mgr.requestEscalation(sessionKey, effectClass, toolName, reason);

    logger.info(
      { sessionKey, toolName, effectClass, requiredLevel },
      "Requesting permission escalation from user",
    );

    const granted = await sink.requestPermission(
      sessionKey,
      toolName,
      effectClass,
      reason,
    );

    if (granted) {
      mgr.grantEscalation(sessionKey, "user");
      return { action: "allow" };
    }

    mgr.denyEscalation(sessionKey);
    return {
      action: "deny",
      reason: `User denied permission escalation for ${effectClass} effect on tool "${toolName}"`,
    };
  }

  // No interactive escalation available — hard deny
  logger.warn(
    { sessionKey, toolName, effectClass, requiredLevel, effectiveLevel },
    "Trust gate denied — no escalation path available",
  );

  return {
    action: "deny",
    reason: `Trust level "${effectiveLevel}" does not permit ${effectClass} effect. Required: ${requiredLevel}`,
  };
}
