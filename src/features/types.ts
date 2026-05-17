/**
 * File-based feature toggle types (Phase 4.19 B2).
 *
 * Toggles live as one JSON file per name under
 * `<workspace>/.crabmeat/features/<name>.json`. The file is the
 * source of truth — components read on every tick rather than
 * holding in-process cached state. Atomic writes (tmp + rename) are
 * the discipline that defends against the Gator failure mode #8
 * (non-atomic state writes corrupting on crash).
 *
 * Semantics: `enabled` is "this toggle is engaged" (the named
 * behavior is blocked / the kill switch is on). Absence of a toggle
 * file is equivalent to `enabled: false`.
 *
 * Examples:
 *   - features/pause.json  enabled=true → all inference is paused
 *   - features/outbound-email.json enabled=true → outbound email
 *     replies are blocked
 *   - features/web-fetch.json enabled=true → web_fetch tool refuses
 *   - features/escalation.json enabled=true → layer2 routes are
 *     bypassed (escalation off)
 */

export interface FeatureFlag {
  /**
   * True = the toggle is engaged. The named behavior is blocked / the
   * kill switch is on. Absence of the file is equivalent to false.
   */
  enabled: boolean;
  /** Human-readable explanation set when the toggle was last engaged. */
  reason?: string;
  /** ISO timestamp of the most recent write. */
  set_at: string;
  /**
   * Source of the most recent write. Free-form, but conventional values
   * are 'cli' (operator typed `crabmeat pause`), 'api' (admin endpoint),
   * 'auto' (set by the system itself, e.g. circuit breaker tripped).
   */
  set_by: string;
}

/**
 * Known feature names. Adding a new entry here is a deliberate
 * decision; the CLI's `crabmeat feature <name>` accepts ANY name
 * (operators may invent their own toggles), but the typed gates that
 * components query refer to these constants.
 */
export const KNOWN_FEATURES = [
  "pause",
  "outbound-email",
  "web-fetch",
  "escalation",
] as const;

export type KnownFeature = (typeof KNOWN_FEATURES)[number];

/** True when the name is one of the typed-gate features. */
export function isKnownFeature(name: string): name is KnownFeature {
  return (KNOWN_FEATURES as readonly string[]).includes(name);
}

/**
 * Validate a feature name as a safe filename — alphanumerics + dashes
 * only, must not start with a dot, length 1..64. Rejecting anything
 * else stops a CLI typo from creating `features/../escape.json` or
 * a 4MB filename.
 */
export function isValidFeatureName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 64) return false;
  return /^[a-z][a-z0-9-]*$/.test(name);
}
