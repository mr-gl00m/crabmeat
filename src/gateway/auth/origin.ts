/**
 * Origin validation for browser WebSocket connections (CSWSH protection).
 *
 * No "dangerouslyAllowHostHeaderOriginFallback" — origin must be in the
 * allowlist or be localhost. Period.
 */

export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  // Non-browser clients (CLI, native apps) may not send Origin
  if (!origin) return true;

  for (const pattern of allowlist) {
    if (matchOriginPattern(origin, pattern)) return true;
  }

  return false;
}

function matchOriginPattern(origin: string, pattern: string): boolean {
  // Exact match
  if (origin === pattern) return true;

  // Wildcard port: "http://localhost:*" matches "http://localhost:3000"
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // "http://localhost:"
    if (origin.startsWith(prefix)) return true;
    // Also match without port (default port)
    const noPort = pattern.slice(0, -2); // "http://localhost"
    if (origin === noPort) return true;
  }

  return false;
}
