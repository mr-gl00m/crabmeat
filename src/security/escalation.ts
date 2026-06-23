/**
 * Runtime permission escalation.
 *
 * Allows agents to request elevated permissions mid-session with user
 * consent. Escalation is session-scoped — resets on disconnect.
 *
 * Permission hierarchy:
 *   untrusted → standard → trusted → admin
 *
 * Each level maps to allowed effect classes:
 *   untrusted: read
 *   standard:  read, write, network
 *   trusted:   read, write, network, exec
 *   admin:     read, write, network, exec, privileged
 *
 * Flow:
 * 1. Tool validation detects that the requested effect class exceeds
 *    the session's current permission level.
 * 2. An escalation request is sent to the user through the ConnectorSink.
 * 3. User grants or denies the request.
 * 4. If granted, the session's permission level is elevated for the
 *    remainder of the connection.
 */

import type { ConnectorTrustLevel } from "../connectors/types.js";
import { logger } from "../infra/logger.js";

// ── Effect class mapping ────────────────────────────────

type EffectClass = "read" | "write" | "network" | "exec" | "privileged";

const TRUST_LEVEL_EFFECTS: Record<ConnectorTrustLevel, Set<EffectClass>> = {
  untrusted: new Set(["read"]),
  standard: new Set(["read", "write", "network"]),
  trusted: new Set(["read", "write", "network", "exec"]),
  admin: new Set(["read", "write", "network", "exec", "privileged"]),
};

const TRUST_LEVEL_ORDER: ConnectorTrustLevel[] = [
  "untrusted", "standard", "trusted", "admin",
];

/**
 * Check if a trust level allows a given effect class.
 */
export function trustLevelAllows(
  level: ConnectorTrustLevel,
  effect: EffectClass,
): boolean {
  return TRUST_LEVEL_EFFECTS[level].has(effect);
}

/**
 * Get the minimum trust level required for an effect class.
 */
export function minimumTrustForEffect(effect: EffectClass): ConnectorTrustLevel {
  for (const level of TRUST_LEVEL_ORDER) {
    if (TRUST_LEVEL_EFFECTS[level].has(effect)) return level;
  }
  return "admin";
}

/**
 * Get allowed effects for a trust level.
 */
export function effectsForTrustLevel(level: ConnectorTrustLevel): EffectClass[] {
  return [...TRUST_LEVEL_EFFECTS[level]];
}

// ── Escalation state ────────────────────────────────────

export interface EscalationRequest {
  sessionKey: string;
  requestedLevel: ConnectorTrustLevel;
  reason: string;
  effectNeeded: EffectClass;
  toolName: string;
  timestamp: string;
}

export interface EscalationGrant {
  sessionKey: string;
  grantedLevel: ConnectorTrustLevel;
  grantedAt: string;
  grantedBy: string;
}

/**
 * Per-session escalation state tracker.
 *
 * Each session starts at its connector's base trust level.
 * Escalations are tracked here and apply for the session lifetime.
 */
export class EscalationManager {
  /** sessionKey → current effective trust level */
  private sessionLevels = new Map<string, ConnectorTrustLevel>();
  /** sessionKey → escalation grants (audit trail) */
  private grants = new Map<string, EscalationGrant[]>();
  /** sessionKey → pending escalation request */
  private pending = new Map<string, EscalationRequest>();

  /**
   * Get the effective trust level for a session.
   * Returns the escalated level if one exists, otherwise the base level.
   */
  getEffectiveLevel(sessionKey: string, baseLevel: ConnectorTrustLevel): ConnectorTrustLevel {
    return this.sessionLevels.get(sessionKey) ?? baseLevel;
  }

  /**
   * Check if a session needs escalation for a given effect.
   */
  needsEscalation(
    sessionKey: string,
    baseLevel: ConnectorTrustLevel,
    effect: EffectClass,
  ): boolean {
    const effective = this.getEffectiveLevel(sessionKey, baseLevel);
    return !trustLevelAllows(effective, effect);
  }

  /**
   * Create a pending escalation request.
   * Returns the request object (caller sends to user via ConnectorSink).
   */
  requestEscalation(
    sessionKey: string,
    effectNeeded: EffectClass,
    toolName: string,
    reason: string,
  ): EscalationRequest {
    const requestedLevel = minimumTrustForEffect(effectNeeded);
    const request: EscalationRequest = {
      sessionKey,
      requestedLevel,
      reason,
      effectNeeded,
      toolName,
      timestamp: new Date().toISOString(),
    };
    this.pending.set(sessionKey, request);
    logger.info(
      { sessionKey, requestedLevel, effectNeeded, toolName },
      "Permission escalation requested",
    );
    return request;
  }

  /**
   * Grant a pending escalation request.
   */
  grantEscalation(sessionKey: string, grantedBy: string = "user"): EscalationGrant | null {
    const request = this.pending.get(sessionKey);
    if (!request) return null;

    this.pending.delete(sessionKey);

    const grant: EscalationGrant = {
      sessionKey,
      grantedLevel: request.requestedLevel,
      grantedAt: new Date().toISOString(),
      grantedBy,
    };

    // Update effective level
    this.sessionLevels.set(sessionKey, request.requestedLevel);

    // Track grant in audit trail
    const sessionGrants = this.grants.get(sessionKey) ?? [];
    sessionGrants.push(grant);
    this.grants.set(sessionKey, sessionGrants);

    logger.info(
      { sessionKey, grantedLevel: grant.grantedLevel, grantedBy },
      "Permission escalation granted",
    );

    return grant;
  }

  /**
   * Deny a pending escalation request.
   */
  denyEscalation(sessionKey: string): void {
    const request = this.pending.get(sessionKey);
    if (request) {
      this.pending.delete(sessionKey);
      logger.info(
        { sessionKey, requestedLevel: request.requestedLevel },
        "Permission escalation denied",
      );
    }
  }

  /**
   * Get the pending request for a session, if any.
   */
  getPendingRequest(sessionKey: string): EscalationRequest | null {
    return this.pending.get(sessionKey) ?? null;
  }

  /**
   * Get all grants for a session (audit trail).
   */
  getGrants(sessionKey: string): EscalationGrant[] {
    return this.grants.get(sessionKey) ?? [];
  }

  /**
   * Reset escalation state for a session (on disconnect).
   */
  resetSession(sessionKey: string): void {
    this.sessionLevels.delete(sessionKey);
    this.grants.delete(sessionKey);
    this.pending.delete(sessionKey);
  }

  /**
   * Clear all state (for testing).
   */
  clear(): void {
    this.sessionLevels.clear();
    this.grants.clear();
    this.pending.clear();
  }
}

/** Singleton escalation manager. */
let instance: EscalationManager | undefined;

export function getEscalationManager(): EscalationManager {
  if (!instance) {
    instance = new EscalationManager();
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetEscalationManager(): void {
  instance?.clear();
  instance = undefined;
}
