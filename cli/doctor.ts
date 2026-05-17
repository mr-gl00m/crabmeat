/**
 * `crabmeat doctor [--strict]` CLI subcommand.
 *
 * Loads config standalone (no gateway) and runs the subset of doctor
 * checks that don't depend on a running pipeline. Intended for CI
 * release gates and pre-start operator validation. Phase 4.18.2.
 *
 * Exit semantics:
 *   - default mode:  exit 0 on no errors; warnings print but don't fail
 *   - --strict:      additionally promotes warnings to failures and
 *                    runs checkReleaseGate (auth=none, missing token,
 *                    non-loopback bind without TLS, admin without
 *                    publicBaseUrl when external connectors, webhooks
 *                    without secrets). Used by CI release pipelines and
 *                    `crabmeat doctor --strict` in the release runbook.
 */

import { loadConfig } from "../config/loader.js";
import {
  checkConfigWarnings,
  checkReleaseGate,
  formatDiagnostics,
  type DiagnosticResult,
} from "../commands/doctor.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  evaluateGreenlight,
  formatGreenlightVerdict,
} from "../gateway/greenlight.js";
import { registerBuiltinTools } from "../agents/tools/builtins.js";

export interface DoctorCliOptions {
  config?: string;
  strict?: boolean;
  /**
   * Greenlight composite check (Phase 4.19 B1). When set, runs the
   * pause-toggle / circuit-breaker / providers-reachable check from
   * `evaluateGreenlight` (with no live gateway, so circuit-breaker
   * and providers report "not checked" — pause is checked because
   * it's file-based). Exit code mirrors the verdict.
   */
  gate?: boolean;
}

export async function runDoctorCli(opts: DoctorCliOptions): Promise<number> {
  // Load config first. If parsing fails (deprecated key, schema reject,
  // missing file), report and exit non-zero before running any checks —
  // a malformed config is itself a release-gate failure.
  let config;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    process.stderr.write(
      `crabmeat doctor: config load failed:\n  ${formatErrorMessage(err)}\n`,
    );
    return 2;
  }

  // Register the built-in tool handlers so the config-warnings check
  // (`hasToolHandler` lookup) doesn't false-fire warnings for tools the
  // example config references. Doctor doesn't run any tools, just
  // queries the registry — registration is the cheap fix.
  registerBuiltinTools();

  // --gate runs only the greenlight composite. It's a separate mode
  // because the doctor static checks and the greenlight runtime check
  // serve different audiences: doctor for release validation, greenlight
  // for "is this gateway taking work right now."
  if (opts.gate) {
    const verdict = await evaluateGreenlight({ config });
    process.stdout.write(formatGreenlightVerdict(verdict) + "\n");
    return verdict.ready ? 0 : 1;
  }

  const results: DiagnosticResult[] = [];

  // checkConfigWarnings needs a CommandContext shape; we pass a minimal
  // shim because the static checks only touch ctx.config.
  // TODO when checkConfigWarnings is split: drop the shim, call the
  // pure-config slice directly.
  const ctxShim = {
    config,
    pipeline: { auditLog: undefined, getProvider: () => undefined } as unknown,
    store: undefined,
  } as unknown as Parameters<typeof checkConfigWarnings>[0];
  results.push(...checkConfigWarnings(ctxShim));

  if (opts.strict) {
    results.push(...checkReleaseGate(config));
  }

  // Print findings exactly the same way the in-session /doctor does
  // so operators see identical output between contexts.
  process.stdout.write(formatDiagnostics(results) + "\n");

  // Counts.
  const errors = results.filter((r) => r.status === "error").length;
  const warns = results.filter((r) => r.status === "warn").length;

  if (errors > 0) return 1;
  if (opts.strict && warns > 0) return 1;
  return 0;
}
