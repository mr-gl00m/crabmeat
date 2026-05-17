import type { ServerResponse } from "node:http";

/** Apply security headers to every HTTP response. */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-XSS-Protection", "0"); // Disabled — CSP is the real protection
  res.removeHeader("X-Powered-By");
}
