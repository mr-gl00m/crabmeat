import { logger } from "../infra/logger.js";
import { diagnostics } from "../infra/diagnostics/index.js";

export type CircuitBreakerState = "closed" | "open";

export interface AutoTripConfig {
  /** Max anomaly events in the window before auto-tripping. Default: 10. */
  threshold: number;
  /** Sliding window in ms. Default: 60_000 (1 min). */
  windowMs: number;
}

const DEFAULT_AUTO_TRIP: AutoTripConfig = { threshold: 10, windowMs: 60_000 };

/**
 * Circuit breaker for the inference pipeline.
 *
 * - **closed** = normal operation, requests flow through
 * - **open**   = tripped, all new inference requests are rejected immediately
 *
 * Supports both manual trip (`trip()`) and automatic trip on anomaly
 * accumulation (`recordAnomaly()`). Anomaly categories: auth failures,
 * tool errors, leak detections, inference errors.
 */
export interface CircuitBreaker {
  /** Current state. */
  readonly state: CircuitBreakerState;
  /** Trip the breaker — reject all new inference requests. */
  trip(reason?: string): void;
  /** Reset the breaker — resume normal operation. */
  reset(): void;
  /** Returns true if requests should be allowed through. */
  isAllowed(): boolean;
  /** Record an anomaly event. Auto-trips if threshold is exceeded within the window. */
  recordAnomaly(category: string): void;
  destroy(): void;
}

export function createCircuitBreaker(autoTrip?: Partial<AutoTripConfig>): CircuitBreaker {
  let state: CircuitBreakerState = "closed";
  const cfg: AutoTripConfig = { ...DEFAULT_AUTO_TRIP, ...autoTrip };
  const anomalyTimestamps: number[] = [];
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - cfg.windowMs;
    while (anomalyTimestamps.length > 0 && anomalyTimestamps[0]! < cutoff) {
      anomalyTimestamps.shift();
    }
  }, cfg.windowMs);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return {
    get state() {
      return state;
    },

    trip(reason?: string) {
      if (state === "open") return;
      state = "open";
      logger.warn({ reason }, "Circuit breaker TRIPPED — inference requests blocked");
    },

    reset() {
      if (state === "closed") return;
      state = "closed";
      anomalyTimestamps.length = 0;
      logger.info("Circuit breaker RESET — inference requests resumed");
    },

    isAllowed() {
      return state === "closed";
    },

    recordAnomaly(category: string) {
      if (state === "open") return;
      const now = Date.now();
      anomalyTimestamps.push(now);
      // Slide window
      const cutoff = now - cfg.windowMs;
      while (anomalyTimestamps.length > 0 && anomalyTimestamps[0]! < cutoff) {
        anomalyTimestamps.shift();
      }
      if (anomalyTimestamps.length >= cfg.threshold) {
        diagnostics.emit("tool.loop", {
          category,
          level: "critical",
          action: "block",
          detector: "global_circuit_breaker",
          count: anomalyTimestamps.length,
          reason: "circuit_breaker_threshold",
        });
        this.trip(`Auto-tripped: ${anomalyTimestamps.length} anomalies (${category}) in ${cfg.windowMs}ms window`);
      }
    },

    destroy() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = undefined;
      }
    },
  };
}
