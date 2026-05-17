/**
 * `crabmeat pause`, `crabmeat resume`, and `crabmeat feature <name> <on|off>`
 * CLI subcommands (Phase 4.19 B2).
 *
 * Operator-facing wrappers around the file-based feature toggle store.
 * Each command produces exactly one toggle write or read; no daemon
 * is required. The agent picks up the change on its next tick.
 */

import {
  writeFeature,
  clearFeature,
  listFeatures,
  isFeatureEngaged,
} from "../features/store.js";
import { isValidFeatureName, KNOWN_FEATURES } from "../features/types.js";

export interface PauseOptions {
  reason?: string;
}

export async function runPauseCli(opts: PauseOptions): Promise<number> {
  await writeFeature("pause", {
    enabled: true,
    reason: opts.reason,
    set_by: "cli",
  });
  process.stdout.write(
    `Paused. The agent will reject inference requests until you run ` +
      `\`crabmeat resume\`.\n`,
  );
  if (opts.reason) {
    process.stdout.write(`Reason: ${opts.reason}\n`);
  }
  return 0;
}

export async function runResumeCli(): Promise<number> {
  // Resume is a clear, not a write-with-enabled=false. The absence of
  // the file is the resumed state, which keeps `crabmeat features`
  // listing terse — only engaged toggles appear.
  const wasEngaged = await isFeatureEngaged("pause");
  await clearFeature("pause");
  if (wasEngaged) {
    process.stdout.write("Resumed. The agent will accept inference requests.\n");
  } else {
    process.stdout.write("Already running (no pause was engaged).\n");
  }
  return 0;
}

export interface FeatureCliOptions {
  name: string;
  state: "on" | "off";
  reason?: string;
}

export async function runFeatureCli(opts: FeatureCliOptions): Promise<number> {
  if (!isValidFeatureName(opts.name)) {
    process.stderr.write(
      `crabmeat feature: invalid name '${opts.name}'. ` +
        `Must be lowercase letters/digits/dashes, start with a letter, length 1-64.\n`,
    );
    return 2;
  }
  if (opts.state === "on") {
    await writeFeature(opts.name, {
      enabled: true,
      reason: opts.reason,
      set_by: "cli",
    });
    const known = (KNOWN_FEATURES as readonly string[]).includes(opts.name)
      ? ""
      : ` (note: '${opts.name}' is not a typed-gate feature; ` +
        `components only consult these: ${KNOWN_FEATURES.join(", ")})`;
    process.stdout.write(`Feature '${opts.name}' engaged.${known}\n`);
    if (opts.reason) {
      process.stdout.write(`Reason: ${opts.reason}\n`);
    }
  } else {
    await clearFeature(opts.name);
    process.stdout.write(`Feature '${opts.name}' disengaged.\n`);
  }
  return 0;
}

export async function runFeatureListCli(): Promise<number> {
  const entries = await listFeatures();
  if (entries.length === 0) {
    process.stdout.write("No feature toggles engaged.\n");
    return 0;
  }
  for (const { name, flag } of entries) {
    const reason = flag.reason ? ` — ${flag.reason}` : "";
    process.stdout.write(
      `${name}: enabled=${flag.enabled} (set ${flag.set_at} by ${flag.set_by})${reason}\n`,
    );
  }
  return 0;
}
