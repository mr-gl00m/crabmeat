/**
 * Three-scope config cascade loader.
 *
 * Resolution order (later scopes override earlier):
 *   1. User config   — ~/.crabmeat/config.json (global defaults)
 *   2. Project config — {cwd}/crabmeat.json or {cwd}/.crabmeat/config.json
 *   3. Local config   — {cwd}/.crabmeat/local.json (gitignored overrides)
 *
 * Merge strategy:
 *   - Scalars: last scope wins
 *   - Arrays (tools, agents, providers, bindings, origins, fileAccessPaths):
 *     extended (concatenated), deduplicated by 'id' where applicable
 *   - Objects: deep-merged recursively
 *
 * The merged result is validated against the full config schema.
 * An explicit path (via CRABMEAT_CONFIG env var or argument) replaces
 * the user+project layers, but {cwd}/.crabmeat/local.json is still
 * overlaid on top if it exists — local overrides are gitignored secrets
 * (webhook URLs, API keys) and must survive any choice of base config.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readJsonFile, fileExists } from "../infra/fs.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadEnv } from "../infra/env.js";
import { configSchema, type Config } from "./schema.js";

// ── Cascade paths ───────────────────────────────────────

function userConfigPath(): string {
  return join(homedir(), ".crabmeat", "config.json");
}

const PROJECT_PATHS = [
  "crabmeat.json",
  join(".crabmeat", "config.json"),
];

function localConfigPath(): string {
  return join(".crabmeat", "local.json");
}

// ── Deprecated-key check ────────────────────────────────

/**
 * Top-level config keys that have been removed in past releases. Maps
 * the dead key to a one-paragraph migration message that points the
 * operator at the replacement. Run BEFORE the zod schema parse so the
 * operator gets the friendly migration text instead of zod's generic
 * "unrecognized key" error from `.strict()`.
 *
 * Phase 4.18.4 — first entry is `layer0`, removed when Arbiter Phase 5
 * landed (2026-04-30) and replaced by the Arbiter intent gate
 * (vendored at crabmeat/vendor/arbiter). A stale `layer0` block in user
 * config would otherwise be
 * silently ignored under the previous permissive schema, leaving the
 * operator thinking they had configured something they had not.
 */
const DEPRECATED_TOP_LEVEL_KEYS: Record<string, string> = {
  layer0:
    "The `layer0` config block was removed in Arbiter Phase 5 (2026-04-30). " +
    "Layer 0 deterministic dispatch was replaced by the external Arbiter " +
    "intent gate (vendored at crabmeat/vendor/arbiter), which is wired in automatically when an " +
    "admin token is set. Delete the `layer0` block from your config — keeping " +
    "it does nothing and the schema now refuses to start with it present.",
};

/**
 * Check the merged config for any top-level keys that have been
 * removed in past releases. Throws a helpful Error naming the dead
 * key and the migration path before configSchema.safeParse can fire.
 *
 * Pre-zod placement is deliberate: the schema's `.strict()` would
 * otherwise produce a generic "Unrecognized key(s) in object: 'layer0'"
 * which gives the operator no idea why or what to do about it.
 */
function assertNoDeprecatedKeys(merged: Record<string, unknown>): void {
  const found: string[] = [];
  for (const key of Object.keys(merged)) {
    if (DEPRECATED_TOP_LEVEL_KEYS[key] !== undefined) {
      found.push(key);
    }
  }
  if (found.length > 0) {
    const messages = found
      .map((k) => `  ${k}: ${DEPRECATED_TOP_LEVEL_KEYS[k]}`)
      .join("\n");
    throw new Error(
      `Config contains deprecated top-level key(s):\n${messages}`,
    );
  }
}

// ── Env-var secret injection ────────────────────────────

/**
 * Inject secrets from environment variables into the merged config
 * before schema validation. Keeps the committed config free of live
 * credentials — the file declares structure, the env supplies the
 * secret. Config-provided values always win if explicitly set.
 *
 * Currently:
 *   CRABMEAT_TOKEN       → gateway.auth.token
 *   CRABMEAT_ADMIN_TOKEN → admin.token
 */
function applyEnvSecrets(merged: Record<string, unknown>): void {
  const envToken = process.env.CRABMEAT_TOKEN;
  if (envToken) {
    const gateway = isPlainObject(merged.gateway) ? merged.gateway : {};
    const auth = isPlainObject(gateway.auth) ? gateway.auth : {};
    if (typeof auth.token !== "string" || auth.token.length === 0) {
      auth.token = envToken;
    }
    gateway.auth = auth;
    merged.gateway = gateway;
  }

  const envAdminToken = process.env.CRABMEAT_ADMIN_TOKEN;
  if (envAdminToken) {
    const admin = isPlainObject(merged.admin) ? merged.admin : {};
    if (typeof admin.token !== "string" || admin.token.length === 0) {
      admin.token = envAdminToken;
    }
    merged.admin = admin;
  }

  // Resolve $SECRET:NAME references in provider apiKey fields. Without
  // this the literal placeholder reaches the upstream SDK as the bearer
  // token and produces a confusing 401 ("****_KEY is invalid") instead
  // of a clear "missing env var" error at startup.
  if (Array.isArray(merged.providers)) {
    for (const provider of merged.providers) {
      if (!isPlainObject(provider)) continue;
      const apiKey = provider.apiKey;
      if (typeof apiKey !== "string") continue;
      const match = /^\$SECRET:(.+)$/.exec(apiKey);
      if (!match) continue;
      const name = match[1]!;
      const value = process.env[name];
      if (!value) {
        const id = typeof provider.id === "string" ? provider.id : "<unknown>";
        throw new Error(
          `Provider '${id}': apiKey references $SECRET:${name} but environment variable ${name} is unset or empty. ` +
            `Set ${name}= in crabmeat/.env or export it in the shell before launching.`,
        );
      }
      provider.apiKey = value;
    }
  }
}

// ── Deep merge ──────────────────────────────────────────

/** Keys whose arrays are extended (concatenated) rather than replaced. */
const EXTEND_ARRAY_KEYS = new Set([
  "tools", "agents", "providers", "bindings", "origins", "fileAccessPaths",
  "fileAccessPresets",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge two config objects.
 * - Arrays at known keys are extended and deduplicated by 'id'.
 * - Objects are recursively merged.
 * - Scalars: target value wins.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideVal] of Object.entries(override)) {
    const baseVal = result[key];

    if (Array.isArray(overrideVal) && EXTEND_ARRAY_KEYS.has(key)) {
      // Extend array, deduplicate by 'id' if present
      const baseArr = Array.isArray(baseVal) ? baseVal : [];
      result[key] = deduplicateById([...baseArr, ...overrideVal]);
    } else if (isPlainObject(overrideVal) && isPlainObject(baseVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

/**
 * Deduplicate an array by 'id' field. Later entries win (override earlier).
 * Items without 'id' are always kept.
 */
function deduplicateById(arr: unknown[]): unknown[] {
  const seen = new Map<string, number>();
  const result: unknown[] = [];

  for (const item of arr) {
    if (isPlainObject(item) && typeof item.id === "string") {
      const existing = seen.get(item.id);
      if (existing !== undefined) {
        // Later entry replaces earlier
        result[existing] = item;
        continue;
      }
      seen.set(item.id, result.length);
    }
    result.push(item);
  }

  return result;
}

// ── Loader ──────────────────────────────────────────────

/**
 * Load and validate configuration.
 *
 * If `explicitPath` is provided (or CRABMEAT_CONFIG is set), loads a
 * single file with no cascade. Otherwise, merges user → project → local.
 */
export async function loadConfig(explicitPath?: string): Promise<Config> {
  const configPath = explicitPath ?? loadEnv().CRABMEAT_CONFIG;

  if (configPath) {
    return readExplicitWithLocalOverlay(configPath);
  }

  return loadCascade();
}

async function loadCascade(): Promise<Config> {
  const layers: Array<{ scope: string; data: Record<string, unknown> }> = [];

  // 1. User config (~/.crabmeat/config.json)
  const userPath = userConfigPath();
  if (await fileExists(userPath)) {
    try {
      const data = await readJsonFile<Record<string, unknown>>(userPath);
      layers.push({ scope: "user", data });
      logger.info({ path: userPath }, "Loaded user config");
    } catch (err) {
      logger.warn(
        { path: userPath, error: formatErrorMessage(err) },
        "Failed to read user config — skipping",
      );
    }
  }

  // 2. Project config (crabmeat.json or .crabmeat/config.json)
  for (const candidate of PROJECT_PATHS) {
    const abs = resolve(candidate);
    if (await fileExists(abs)) {
      try {
        const data = await readJsonFile<Record<string, unknown>>(abs);
        layers.push({ scope: "project", data });
        logger.info({ path: abs }, "Loaded project config");
      } catch (err) {
        logger.warn(
          { path: abs, error: formatErrorMessage(err) },
          "Failed to read project config — skipping",
        );
      }
      break; // Only use the first found project config
    }
  }

  // 3. Local config (.crabmeat/local.json)
  const localPath = resolve(localConfigPath());
  if (await fileExists(localPath)) {
    try {
      const data = await readJsonFile<Record<string, unknown>>(localPath);
      layers.push({ scope: "local", data });
      logger.info({ path: localPath }, "Loaded local config override");
    } catch (err) {
      logger.warn(
        { path: localPath, error: formatErrorMessage(err) },
        "Failed to read local config — skipping",
      );
    }
  }

  if (layers.length === 0) {
    throw new Error(
      `No config file found. Tried: ${userPath}, ${PROJECT_PATHS.join(", ")}, ${localPath}. ` +
        "Create one or set CRABMEAT_CONFIG.",
    );
  }

  // Merge layers: user → project → local
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.data);
  }

  applyEnvSecrets(merged);
  // Friendly migration messages for known-removed keys before the
  // schema's `.strict()` would surface the generic "unrecognized key"
  // error. Phase 4.18.4.
  assertNoDeprecatedKeys(merged);

  // Validate merged result
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const scopes = layers.map((l) => l.scope).join(" + ");
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed (merged: ${scopes}):\n${issues}`);
  }

  logger.info(
    { scopes: layers.map((l) => l.scope) },
    "Config cascade loaded and validated",
  );

  // Email-intent guard. crabmeat.json ships a top-level `_emailImap_note`
  // placeholder signalling the operator means to run the email connector,
  // but the credentials must arrive from a user or local scope
  // (~/.crabmeat/config.json or .crabmeat/local.json). If that scope is
  // missing — e.g. a workspace refresh drops the gitignored local.json —
  // connectors.emailImap silently resolves to undefined, the gateway skips
  // starting the connector, and the box looks healthy while never touching
  // the mailbox. (This exact gap went unnoticed for ~6 days: 2026-05-22.)
  // Warn loudly at boot so it's visible immediately, not days later.
  const emailIntentDeclared =
    typeof (merged as Record<string, unknown>)["_emailImap_note"] === "string";
  if (emailIntentDeclared && !result.data.connectors.emailImap) {
    logger.warn(
      { scopesLoaded: layers.map((l) => l.scope), expectedLocal: localPath, expectedUser: userPath },
      "email-imap: crabmeat.json declares email intent (_emailImap_note) but no connectors.emailImap credentials resolved from any scope — the email connector will NOT start and no mail will be polled. Create .crabmeat/local.json (or run `crabmeat setup`) with user/password/allowFromAddresses.",
    );
  }

  return result.data;
}

/**
 * Read an explicit base config and overlay {cwd}/.crabmeat/local.json
 * on top if it exists. Local overrides hold gitignored secrets (webhook
 * URLs, API keys) and must apply regardless of which base the user picks.
 */
async function readExplicitWithLocalOverlay(filePath: string): Promise<Config> {
  const baseAbs = resolve(filePath);
  const baseRaw = await readJsonFile<Record<string, unknown>>(baseAbs);

  const localPath = resolve(localConfigPath());
  let merged: Record<string, unknown> = baseRaw;
  let overlaid = false;

  if (await fileExists(localPath)) {
    try {
      const localRaw = await readJsonFile<Record<string, unknown>>(localPath);
      merged = deepMerge(baseRaw, localRaw);
      overlaid = true;
      logger.info({ path: localPath }, "Loaded local config override");
    } catch (err) {
      logger.warn(
        { path: localPath, error: formatErrorMessage(err) },
        "Failed to read local config — skipping",
      );
    }
  }

  applyEnvSecrets(merged);
  assertNoDeprecatedKeys(merged);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const scope = overlaid ? "explicit + local" : "explicit";
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed (${scope}):\n${issues}`);
  }

  logger.info(
    { path: baseAbs, overlaid },
    overlaid
      ? "Config loaded and validated (explicit base + local overlay)"
      : "Config loaded and validated",
  );
  return result.data;
}
