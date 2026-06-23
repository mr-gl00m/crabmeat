/**
 * Layer 2 Health Check
 *
 * Verifies the local model provider (typically Ollama) is running and
 * responsive before routing requests to it. Uses a cached result to
 * avoid pinging the model on every request.
 */

import type { Provider, StreamEvent } from "../providers/types.js";
import { logger } from "../../infra/logger.js";

// ── Health cache ─────────────────────────────────────────

interface HealthState {
  healthy: boolean;
  checkedAt: number;
}

const healthCache = new Map<string, HealthState>();
const CACHE_TTL_MS = 30_000; // Re-check every 30 seconds

/**
 * Check whether the Layer 2 provider is responsive.
 * Sends a minimal 1-token request and races it against a timeout.
 * Results are cached for 30 seconds.
 */
export async function checkLayer2Health(
  provider: Provider,
  timeoutMs: number,
): Promise<boolean> {
  // Check cache first
  const cached = healthCache.get(provider.id);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.healthy;
  }

  let healthy = false;

  try {
    healthy = await Promise.race([
      pingProvider(provider),
      timeout(timeoutMs),
    ]);
  } catch {
    healthy = false;
  }

  // Cache the result
  healthCache.set(provider.id, { healthy, checkedAt: Date.now() });

  if (!healthy) {
    logger.warn(
      { providerId: provider.id, timeoutMs },
      "Layer 2 health check failed — local model may be unavailable",
    );
  }

  return healthy;
}

/** Clear cached health state, forcing a fresh check on next call. */
export function resetHealthCache(providerId?: string): void {
  if (providerId) {
    healthCache.delete(providerId);
  } else {
    healthCache.clear();
  }
}

/** Check if a valid (non-expired) cache entry exists. Exposed for testing. */
export function isHealthCacheValid(providerId: string): boolean {
  const cached = healthCache.get(providerId);
  if (!cached) return false;
  return Date.now() - cached.checkedAt < CACHE_TTL_MS;
}

// ── Internal helpers ─────────────────────────────────────

/**
 * Send a minimal completion request. Resolves true on first token,
 * false on error.
 */
function pingProvider(provider: Provider): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;

    provider
      .stream(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "",
          maxTokens: 1,
          temperature: 0,
        },
        (event: StreamEvent) => {
          if (resolved) return;
          if (event.type === "token") {
            resolved = true;
            resolve(true);
          } else if (event.type === "error") {
            resolved = true;
            resolve(false);
          } else if (event.type === "done") {
            // Got a 'done' without any token — still means it responded
            resolved = true;
            resolve(true);
          }
        },
      )
      .catch(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
  });
}

function timeout(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}
