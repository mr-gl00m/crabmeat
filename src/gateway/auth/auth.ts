import type { GatewayConfig } from "../../config/types.js";
import { secretEqual } from "../../security/secret-equal.js";
import { resolveAuthMode, type AuthResult } from "./policy.js";

/**
 * Unified auth entry point. Checks credentials against the configured
 * auth mode. Returns a result object — never throws.
 */
export function authenticate(
  config: GatewayConfig,
  credentials: { token?: string; password?: string },
): AuthResult {
  const mode = resolveAuthMode(config);

  if (mode === "none") {
    return { authenticated: true };
  }

  if (mode === "token") {
    if (!credentials.token) {
      return { authenticated: false, reason: "Token required" };
    }
    if (!secretEqual(credentials.token, config.auth.token!)) {
      return { authenticated: false, reason: "Invalid token" };
    }
    return { authenticated: true };
  }

  if (mode === "password") {
    if (!credentials.password) {
      return { authenticated: false, reason: "Password required" };
    }
    if (!secretEqual(credentials.password, config.auth.password!)) {
      return { authenticated: false, reason: "Invalid password" };
    }
    return { authenticated: true };
  }

  return { authenticated: false, reason: "Unknown auth mode" };
}
