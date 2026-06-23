/**
 * connector-status — surfaced failure channel for connectors.
 *
 * Connector async workflows (IMAP poll, SMTP send, WS push) can fail
 * independently of the agent's turn. Logging alone isn't enough: a broken
 * SMTP auth that silently fails every outbound reply is invisible to the
 * agent (and the user, until they notice replies stopped arriving). This
 * module gives connectors a tiny surface to report recent failures; the
 * dynamic-notices builder pulls from it each turn so the agent sees
 * "your last 3 replies to X failed with SMTP 535" and can say so in chat.
 *
 * Intentionally in-memory and unpersisted — connector-state belongs to
 * the running process, and stale failures from a prior run would mislead.
 */

const MAX_FAILURES_PER_CONNECTOR = 5;
const FAILURE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ConnectorFailure {
  /** Connector id (e.g. "email-imap" or the configured connector name). */
  connectorId: string;
  /** Short, stable failure kind — used to dedupe repeated identical failures. */
  kind: string;
  /** Short operator-readable detail (pre-redacted — do not include secrets). */
  detail: string;
  /** Optional target (recipient address, endpoint) the failure was against. */
  target?: string;
  /** Wall-clock time of the failure. */
  at: number;
}

const failures = new Map<string, ConnectorFailure[]>();

export function recordConnectorFailure(f: Omit<ConnectorFailure, "at">): void {
  const now = Date.now();
  let list = failures.get(f.connectorId);
  if (!list) {
    list = [];
    failures.set(f.connectorId, list);
  }
  list.push({ ...f, at: now });
  // Trim to MAX_FAILURES_PER_CONNECTOR (keep most recent).
  if (list.length > MAX_FAILURES_PER_CONNECTOR) {
    list.splice(0, list.length - MAX_FAILURES_PER_CONNECTOR);
  }
}

function reapExpired(now: number): void {
  for (const [id, list] of failures) {
    const fresh = list.filter((f) => now - f.at < FAILURE_TTL_MS);
    if (fresh.length === 0) {
      failures.delete(id);
    } else if (fresh.length !== list.length) {
      failures.set(id, fresh);
    }
  }
}

/**
 * Render a notice string for inclusion in the dynamic notices block. Returns
 * empty string when no recent failures are recorded.
 */
export function renderConnectorStatusNotice(): string {
  const now = Date.now();
  reapExpired(now);
  if (failures.size === 0) return "";

  const lines: string[] = ["[CONNECTOR STATUS]"];
  lines.push("Recent connector failures the user may not be aware of:");
  for (const [id, list] of failures) {
    for (const f of list) {
      const ago = Math.round((now - f.at) / 1000);
      const target = f.target ? ` → ${f.target}` : "";
      lines.push(`  - ${id}${target}: ${f.kind} (${f.detail}) [${ago}s ago]`);
    }
  }
  lines.push("If the user asks whether a prior message was delivered, reference this. Do not silently assume success.");
  return lines.join("\n");
}

/** Clear all recorded failures (tests, operator reset). */
export function clearConnectorFailures(): void {
  failures.clear();
}

/** Introspection helper for tests. */
export function _listConnectorFailures(): ReadonlyMap<string, readonly ConnectorFailure[]> {
  return failures;
}
