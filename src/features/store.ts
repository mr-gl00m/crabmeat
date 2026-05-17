/**
 * File-based feature toggle store (Phase 4.19 B2).
 *
 * Each toggle is a single JSON file under `<root>/features/<name>.json`.
 * Reads are synchronous-feeling (read every tick — tiny files, OS page
 * cache absorbs the overhead) and writes are atomic via tmp + rename so
 * a crash mid-write can't leave a corrupted toggle.
 *
 * Default root is `<workspace>/.crabmeat/features/`. Resolved through
 * `getWorkspaceRoot()` so the test harness's tmpdir-based workspace
 * picks up isolated state per test run.
 */

import { readFile, readdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../infra/fs.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type FeatureFlag,
  isValidFeatureName,
} from "./types.js";

let rootOverride: string | undefined;

/**
 * Override the features directory root. Default is
 * `<workspace>/.crabmeat/features/`. Tests inject a tmpdir via this
 * setter; production callers should leave it alone.
 */
export function setFeaturesRoot(absolutePath: string | undefined): void {
  rootOverride = absolutePath ? resolve(absolutePath) : undefined;
}

// ESM-compatible require for the lazy circular-dep dodge below. Plain
// `require` is undefined under "type": "module" — every feature read
// (including `pause`) was silently failing with "require is not defined"
// until this was switched to createRequire(import.meta.url).
const requireFromHere = createRequire(import.meta.url);

function defaultFeaturesRoot(): string {
  // Lazy-import to avoid a circular dep with builtins.ts which itself
  // depends on the wider tools wiring.
  const { getWorkspaceRoot } = requireFromHere("../agents/tools/builtins.js") as {
    getWorkspaceRoot: () => string;
  };
  return resolve(getWorkspaceRoot(), ".crabmeat", "features");
}

function featuresRoot(): string {
  return rootOverride ?? defaultFeaturesRoot();
}

function pathFor(name: string): string {
  return join(featuresRoot(), `${name}.json`);
}

/**
 * Read a toggle. Returns null when the file does not exist OR is
 * unreadable / malformed. Read-failure is the same shape as absence
 * because both should be treated as "this gate is not engaged" — a
 * corrupt toggle file should not silently block the system.
 */
export async function readFeature(name: string): Promise<FeatureFlag | null> {
  if (!isValidFeatureName(name)) return null;
  try {
    const text = await readFile(pathFor(name), "utf-8");
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).enabled === "boolean" &&
      typeof (parsed as Record<string, unknown>).set_at === "string" &&
      typeof (parsed as Record<string, unknown>).set_by === "string"
    ) {
      const obj = parsed as Record<string, unknown>;
      const out: FeatureFlag = {
        enabled: obj.enabled as boolean,
        set_at: obj.set_at as string,
        set_by: obj.set_by as string,
      };
      if (typeof obj.reason === "string") out.reason = obj.reason;
      return out;
    }
    logger.warn(
      { feature: name, path: pathFor(name) },
      "feature toggle file has invalid shape — treating as absent",
    );
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    logger.warn(
      { feature: name, error: formatErrorMessage(err) },
      "feature toggle read failed — treating as absent",
    );
    return null;
  }
}

/** Convenience: true when the named toggle is engaged. */
export async function isFeatureEngaged(name: string): Promise<boolean> {
  const flag = await readFeature(name);
  return flag?.enabled === true;
}

/**
 * Write a toggle atomically. The set_at timestamp is set here, not
 * by the caller, so the file always reflects when the write actually
 * happened. The reason field is optional but conventional.
 */
export async function writeFeature(
  name: string,
  payload: { enabled: boolean; reason?: string; set_by: string },
): Promise<void> {
  if (!isValidFeatureName(name)) {
    throw new Error(
      `Invalid feature name '${name}'. Must be lowercase letters / digits / dashes, ` +
        `start with a letter, length 1-64.`,
    );
  }
  const out: FeatureFlag = {
    enabled: payload.enabled,
    set_at: new Date().toISOString(),
    set_by: payload.set_by,
  };
  if (payload.reason !== undefined) out.reason = payload.reason;
  await writeFileAtomic(pathFor(name), JSON.stringify(out, null, 2) + "\n");
  logger.info(
    {
      feature: name,
      enabled: payload.enabled,
      set_by: payload.set_by,
      reason: payload.reason,
    },
    "feature toggle updated",
  );
}

/**
 * Remove a toggle entirely. Equivalent to "no override" — readFeature
 * returns null after this, which means "not engaged". Useful for the
 * `crabmeat resume` path that wants to indicate "back to defaults"
 * rather than explicitly disabling.
 */
export async function clearFeature(name: string): Promise<void> {
  if (!isValidFeatureName(name)) return;
  try {
    await unlink(pathFor(name));
    logger.info({ feature: name }, "feature toggle cleared");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(
        { feature: name, error: formatErrorMessage(err) },
        "feature toggle clear failed",
      );
    }
  }
}

/**
 * List every toggle present in the features directory. Returns an
 * array of { name, flag } entries. Files that fail to parse are
 * skipped — same conservative treatment as readFeature.
 */
export async function listFeatures(): Promise<Array<{ name: string; flag: FeatureFlag }>> {
  let entries;
  try {
    entries = await readdir(featuresRoot(), { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn(
      { error: formatErrorMessage(err) },
      "feature toggles directory unreadable",
    );
    return [];
  }
  const out: Array<{ name: string; flag: FeatureFlag }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const name = e.name.slice(0, -5);
    if (!isValidFeatureName(name)) continue;
    const flag = await readFeature(name);
    if (flag) out.push({ name, flag });
  }
  return out;
}
