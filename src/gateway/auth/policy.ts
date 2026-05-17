import type { GatewayConfig } from "../../config/types.js";

export type AuthMode = "token" | "password" | "none";

export interface AuthResult {
  authenticated: boolean;
  reason?: string;
}

/**
 * Resolve the auth mode from config. No hidden bypass flags.
 * If mode is "token", a token must be configured.
 * If mode is "password", a password must be configured.
 */
export function resolveAuthMode(config: GatewayConfig): AuthMode {
  const mode = config.auth.mode;

  if (mode === "token" && !config.auth.token) {
    throw new Error(
      'Auth mode is "token" but no gateway.auth.token configured',
    );
  }

  if (mode === "password" && !config.auth.password) {
    throw new Error(
      'Auth mode is "password" but no gateway.auth.password configured',
    );
  }

  return mode;
}
