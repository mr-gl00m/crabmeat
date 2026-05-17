import { randomBytes } from "node:crypto";

const CANARY_PREFIX = "CLWM_CANARY_";
const CANARY_HEX_LENGTH = 32; // hex chars after prefix

/** Session key → canary token */
const canaryRegistry = new Map<string, string>();

/**
 * Mint a per-session canary token. Returns the same token for the
 * same session key (cached). Injected into IRONCLAD_CONTEXT — if it
 * appears in LLM output, the model is leaking system prompt content.
 */
export function mintCanaryToken(sessionKey: string): string {
  const existing = canaryRegistry.get(sessionKey);
  if (existing) return existing;
  const token =
    CANARY_PREFIX + randomBytes(CANARY_HEX_LENGTH / 2).toString("hex");
  canaryRegistry.set(sessionKey, token);
  return token;
}

/** Retrieve a previously minted canary (undefined if none). */
export function getCanaryToken(sessionKey: string): string | undefined {
  return canaryRegistry.get(sessionKey);
}

/** Check if a string contains a canary prefix. */
export function isCanary(text: string): boolean {
  return text.includes(CANARY_PREFIX);
}

/**
 * Build a regex that matches the canary for a given session.
 * Returns undefined if no canary has been minted for this session.
 */
export function buildCanaryPattern(
  sessionKey: string,
): RegExp | undefined {
  const token = canaryRegistry.get(sessionKey);
  if (!token) return undefined;
  return new RegExp(token, "g");
}

/** Remove a session's canary (e.g. on session cleanup). */
export function revokeCanary(sessionKey: string): void {
  canaryRegistry.delete(sessionKey);
}

/** Clear all canaries (testing only). */
export function clearCanaries(): void {
  canaryRegistry.clear();
}
