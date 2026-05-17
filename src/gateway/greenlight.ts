/**
 * Greenlight protocol (Phase 4.19 B1).
 *
 * Composite go/no-go check for "is the gateway ready to accept work?"
 * Folds the standalone gates the operator already has — circuit
 * breaker state, the file-based pause toggle, provider reachability —
 * into one binary verdict + a list of reasons. Either the system is
 * green and accepting work, or it's red and the response names the
 * specific failing component(s) so the operator can fix the named
 * thing rather than chasing through three diagnostic surfaces.
 *
 * Components NOT included for v0.1.0:
 *   - kill-tokens-clean: kill tokens are session-scoped (one token
 *     per outbound message), not a global signal. The escalation path
 *     when one is redeemed is the circuit breaker, which IS a check
 *     here — so the operator-visible signal still reaches greenlight.
 *   - capability-wall-not-exhausted: per-session counter. A future
 *     enhancement could surface a "any session exhausted in the last
 *     N minutes" rolled-up signal.
 *
 * Exposed two ways:
 *   - GET /greenlight (HTTP route)
 *   - `crabmeat doctor --gate` (CLI exit-coded)
 *
 * Both call evaluateGreenlight() and report the verdict.
 */

import type { Config } from "../config/types.js";
import type { CircuitBreaker } from "../security/circuit-breaker.js";
import type { Provider } from "../agents/providers/types.js";
import { checkLayer2Health } from "../agents/layer2/health.js";
import { readFeature } from "../features/store.js";

export interface GreenlightComponentResult {
  /** Stable identifier for the component. */
  name:
    | "pause"
    | "circuit-breaker"
    | "providers";
  /** True when this component is green. */
  ready: boolean;
  /** Operator-readable explanation. Always populated. */
  detail: string;
}

export interface GreenlightVerdict {
  /** True when EVERY component is ready. */
  ready: boolean;
  /** Per-component results. Same order across calls for stable display. */
  components: GreenlightComponentResult[];
  /** ISO timestamp the verdict was computed. */
  evaluatedAt: string;
}

export interface GreenlightDeps {
  config: Config;
  /** Optional — when omitted, the circuit-breaker check is skipped. */
  circuitBreaker?: CircuitBreaker;
  /**
   * Lookup function for live providers (e.g. pipeline.getProvider).
   * Optional so the CLI doctor --gate path can call evaluateGreenlight
   * without a running pipeline; in that case the providers component
   * is reported as "not checked."
   */
  getProvider?: (id: string) => Provider | undefined;
}

const PROVIDER_HEALTH_TIMEOUT_MS = 5_000;

export async function evaluateGreenlight(
  deps: GreenlightDeps,
): Promise<GreenlightVerdict> {
  const components: GreenlightComponentResult[] = [];

  // 1. Pause toggle. Read first because it's the cheapest check and
  //    the most likely "the operator is intentionally blocking work"
  //    signal — usually the answer to "why is greenlight red?".
  const pauseFlag = await readFeature("pause");
  if (pauseFlag?.enabled === true) {
    const reason = pauseFlag.reason ? ` Reason: ${pauseFlag.reason}.` : "";
    components.push({
      name: "pause",
      ready: false,
      detail:
        `Pause toggle engaged at ${pauseFlag.set_at} by ${pauseFlag.set_by}.${reason} ` +
        `Run \`crabmeat resume\` to clear.`,
    });
  } else {
    components.push({
      name: "pause",
      ready: true,
      detail: "Pause toggle not engaged.",
    });
  }

  // 2. Circuit breaker. When deps.circuitBreaker is omitted (CLI doctor
  //    --gate path that doesn't have a live gateway) we report the
  //    component as ready with a "not checked" detail — the absence
  //    of a live circuit breaker is not the same as a tripped one.
  if (deps.circuitBreaker) {
    if (!deps.circuitBreaker.isAllowed()) {
      components.push({
        name: "circuit-breaker",
        ready: false,
        detail:
          "Circuit breaker is open. Inference requests are blocked. " +
          "Inspect /admin/circuit-breaker or the audit chain for the trip cause; " +
          "POST /admin/circuit-breaker {\"action\":\"reset\"} to clear.",
      });
    } else {
      components.push({
        name: "circuit-breaker",
        ready: true,
        detail: "Circuit breaker closed.",
      });
    }
  } else {
    components.push({
      name: "circuit-breaker",
      ready: true,
      detail: "Circuit breaker not checked (no live gateway in this context).",
    });
  }

  // 3. Provider reachability. Run all providers in parallel because
  //    the timeout is the dominating cost and we want the worst-case
  //    greenlight latency to be one timeout, not N timeouts. When the
  //    getProvider hook is omitted (CLI doctor --gate path) we report
  //    "not checked" rather than failing — the absence of a live
  //    gateway is not the same as an unhealthy one.
  if (deps.getProvider) {
    const lookup = deps.getProvider;
    const ids = deps.config.providers.map((p) => p.id);
    const checks = await Promise.all(
      ids.map(async (id) => {
        const provider = lookup(id);
        if (!provider) return { id, healthy: false, missing: true };
        try {
          const healthy = await checkLayer2Health(
            provider,
            PROVIDER_HEALTH_TIMEOUT_MS,
          );
          return { id, healthy, missing: false };
        } catch {
          return { id, healthy: false, missing: false };
        }
      }),
    );
    const unreachable = checks.filter((c) => !c.healthy).map((c) => c.id);
    if (unreachable.length > 0) {
      components.push({
        name: "providers",
        ready: false,
        detail:
          `Provider(s) unreachable: ${unreachable.join(", ")}. ` +
          `Check the provider configuration and network reachability.`,
      });
    } else {
      components.push({
        name: "providers",
        ready: true,
        detail: `${checks.length} provider(s) healthy.`,
      });
    }
  } else {
    components.push({
      name: "providers",
      ready: true,
      detail: "Providers not checked (no live gateway in this context).",
    });
  }

  return {
    ready: components.every((c) => c.ready),
    components,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Format a verdict for human-readable output (CLI / doctor --gate). */
export function formatGreenlightVerdict(verdict: GreenlightVerdict): string {
  const header = verdict.ready
    ? `[GREEN] Gateway is ready. Evaluated ${verdict.evaluatedAt}.`
    : `[RED] Gateway is NOT ready. Evaluated ${verdict.evaluatedAt}.`;
  const lines = verdict.components.map(
    (c) => `  ${c.ready ? "[OK] " : "[FAIL]"} ${c.name}: ${c.detail}`,
  );
  return [header, ...lines].join("\n");
}
