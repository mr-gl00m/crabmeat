/**
 * launch_app — open a desktop application by natural-language name.
 *
 * Deliberately minimal LLM surface: launch_app(name, alias?, dry_run?).
 * All intelligence is deterministic code behind the schema:
 *
 *   1. App registry — scanned via PowerShell Get-StartApps (covers both
 *      win32 and UWP apps without parsing .lnk binaries), cached to
 *      .crabmeat/app-registry.json with a TTL, rescanned on miss.
 *   2. Alias store — .crabmeat/app-aliases.json maps learned phrasings
 *      ("googles") to apps. Checked BEFORE fuzzy matching, so a learned
 *      phrase resolves with no ambiguity forever after.
 *   3. Confidence gate — exact/alias/strong-unique matches launch
 *      immediately; ambiguous matches return a candidate list and DO NOT
 *      launch (the model relays "did you mean…" to the user, then calls
 *      again with the exact name and alias=<original phrase> to learn it).
 *
 * Launch is dispatch-only: explorer.exe shell:AppsFolder\<AppID> returns
 * immediately and cannot confirm a window appeared. The result text says
 * "dispatched", not "running" — window-level verification is the Desktop
 * choreography phase's verify_action, not this tool.
 *
 * Windows-only for now; other platforms get an honest unsupported error.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { writeFileAtomic } from "../../infra/fs.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";

type BuiltinResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

export interface InstalledApp {
  name: string;
  appId: string;
}

interface AliasEntry {
  name: string;
  appId: string;
  addedAt: string;
}

interface AliasStore {
  aliases: Record<string, AliasEntry>;
}

interface RegistryCache {
  scannedAt: number;
  apps: InstalledApp[];
}

const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_MISS_RESCAN_MIN_AGE_MS = 5 * 60 * 1000;
const SCAN_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES = 5;

// Confidence gate thresholds. Top match launches only when it is both
// strong in absolute terms AND clearly ahead of the runner-up.
const AUTO_LAUNCH_MIN_SCORE = 75;
const AUTO_LAUNCH_MIN_LEAD = 15;
const CANDIDATE_MIN_SCORE = 25;

// Match-quality scores (descending by certainty).
const SCORE_EXACT = 100;
const SCORE_PREFIX = 85;
const SCORE_SUBSTRING = 75;
const SCORE_ALL_TOKENS = 65;
const SCORE_TOKEN_PREFIX = 50;
const SCORE_PARTIAL_TOKENS_MAX = 30;

// ── Injectable dependencies (overridden in tests) ─────────

export interface LaunchAppDeps {
  scanApps: () => Promise<InstalledApp[]>;
  /** Dispatch the launch. Throws on spawn failure. */
  spawnApp: (app: InstalledApp) => Promise<void>;
  /** Directory holding app-registry.json / app-aliases.json. */
  stateDir: string;
  platform: () => string;
  now: () => number;
}

function defaultScanApps(): Promise<InstalledApp[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          rejectPromise(new Error(`Get-StartApps failed: ${formatErrorMessage(err)}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          const raw = Array.isArray(parsed) ? parsed : [parsed];
          const apps: InstalledApp[] = [];
          for (const entry of raw) {
            const e = entry as { Name?: unknown; AppID?: unknown };
            if (typeof e?.Name === "string" && typeof e?.AppID === "string") {
              apps.push({ name: e.Name, appId: e.AppID });
            }
          }
          resolvePromise(apps);
        } catch (parseErr: unknown) {
          rejectPromise(new Error(`Get-StartApps output unparseable: ${formatErrorMessage(parseErr)}`));
        }
      },
    );
  });
}

function defaultSpawnApp(app: InstalledApp): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      const child = spawn("explorer.exe", [`shell:AppsFolder\\${app.appId}`], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("error", (err) => rejectPromise(err));
      // explorer.exe exits immediately after dispatching; "spawn" firing
      // means the dispatch itself succeeded.
      child.once("spawn", () => {
        child.unref();
        resolvePromise();
      });
    } catch (err: unknown) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

let deps: LaunchAppDeps = {
  scanApps: defaultScanApps,
  spawnApp: defaultSpawnApp,
  stateDir: join(process.cwd(), ".crabmeat"),
  platform: () => platform(),
  now: () => Date.now(),
};

/** Test hook: swap out scanning/spawning/storage. Returns prior deps. */
export function setLaunchAppDeps(next: Partial<LaunchAppDeps>): LaunchAppDeps {
  const prior = deps;
  deps = { ...deps, ...next };
  return prior;
}

/** Test hook: drop the in-memory registry cache. */
export function _resetLaunchAppCacheForTests(): void {
  registryCache = null;
}

// ── Registry cache ────────────────────────────────────────

let registryCache: RegistryCache | null = null;

function registryPath(): string {
  return join(deps.stateDir, "app-registry.json");
}

function aliasPath(): string {
  return join(deps.stateDir, "app-aliases.json");
}

async function loadRegistry(): Promise<RegistryCache | null> {
  if (registryCache) return registryCache;
  try {
    const raw = await readFile(registryPath(), "utf-8");
    const parsed = JSON.parse(raw) as RegistryCache;
    if (typeof parsed?.scannedAt === "number" && Array.isArray(parsed?.apps)) {
      registryCache = parsed;
      return parsed;
    }
  } catch {
    // missing or corrupt cache — treat as absent, a rescan rebuilds it
  }
  return null;
}

async function saveRegistry(cache: RegistryCache): Promise<void> {
  registryCache = cache;
  try {
    await mkdir(deps.stateDir, { recursive: true });
    await writeFileAtomic(registryPath(), JSON.stringify(cache, null, 2));
  } catch (err: unknown) {
    // Cache persistence failure is non-fatal (in-memory copy still valid),
    // but never silent.
    logger.warn({ err: formatErrorMessage(err) }, "launch_app: failed to persist app registry cache");
  }
}

async function getApps(forceRescan: boolean): Promise<InstalledApp[]> {
  const cached = await loadRegistry();
  const fresh = cached !== null && deps.now() - cached.scannedAt < REGISTRY_TTL_MS;
  if (cached && fresh && !forceRescan) return cached.apps;

  const apps = await deps.scanApps();
  await saveRegistry({ scannedAt: deps.now(), apps });
  return apps;
}

// ── Alias store ───────────────────────────────────────────

async function loadAliases(): Promise<AliasStore> {
  try {
    const raw = await readFile(aliasPath(), "utf-8");
    const parsed = JSON.parse(raw) as AliasStore;
    if (parsed && typeof parsed.aliases === "object" && parsed.aliases !== null) {
      return parsed;
    }
  } catch {
    // missing or corrupt — start empty
  }
  return { aliases: {} };
}

async function saveAlias(phrase: string, app: InstalledApp): Promise<void> {
  const store = await loadAliases();
  store.aliases[normalize(phrase)] = {
    name: app.name,
    appId: app.appId,
    addedAt: new Date().toISOString(),
  };
  await mkdir(deps.stateDir, { recursive: true });
  await writeFileAtomic(aliasPath(), JSON.stringify(store, null, 2));
}

// ── Resolver ──────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

interface Scored {
  app: InstalledApp;
  score: number;
}

function scoreApp(queryNorm: string, queryTokens: string[], app: InstalledApp): number {
  const nameNorm = normalize(app.name);
  if (nameNorm === queryNorm) return SCORE_EXACT;
  if (nameNorm.startsWith(queryNorm)) return SCORE_PREFIX;
  if (nameNorm.includes(queryNorm)) return SCORE_SUBSTRING;

  const nameTokens = nameNorm.split(" ");
  let matched = 0;
  let prefixMatched = 0;
  for (const qt of queryTokens) {
    if (nameTokens.includes(qt)) {
      matched++;
      continue;
    }
    // Bidirectional token-prefix: "googles" ~ "google", "calc" ~ "calculator".
    if (nameTokens.some((nt) => (qt.length >= 4 && nt.startsWith(qt.slice(0, 4)) && qt.startsWith(nt.slice(0, 4))) || nt.startsWith(qt) || qt.startsWith(nt))) {
      prefixMatched++;
    }
  }
  if (matched === queryTokens.length) return SCORE_ALL_TOKENS;
  if (matched + prefixMatched === 0) return 0;
  if (prefixMatched > 0 && matched + prefixMatched === queryTokens.length) {
    return SCORE_TOKEN_PREFIX;
  }
  return Math.round(SCORE_PARTIAL_TOKENS_MAX * ((matched + prefixMatched) / queryTokens.length));
}

interface Resolution {
  kind: "alias" | "auto" | "ambiguous" | "none";
  app?: InstalledApp;
  candidates?: Scored[];
}

function resolveAgainst(apps: InstalledApp[], queryNorm: string): Resolution {
  const queryTokens = queryNorm.split(" ").filter((t) => t.length > 0);
  const scored: Scored[] = apps
    .map((app) => ({ app, score: scoreApp(queryNorm, queryTokens, app) }))
    .filter((s) => s.score >= CANDIDATE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));

  if (scored.length === 0) return { kind: "none" };

  const top = scored[0]!;
  const second = scored[1];
  const lead = second ? top.score - second.score : top.score;
  if (top.score >= AUTO_LAUNCH_MIN_SCORE && lead >= AUTO_LAUNCH_MIN_LEAD) {
    return { kind: "auto", app: top.app };
  }
  return { kind: "ambiguous", candidates: scored.slice(0, MAX_CANDIDATES) };
}

// ── Handler ───────────────────────────────────────────────

async function handleLaunchApp(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const name = ((params.name as string | undefined) ?? "").trim();
  const aliasPhrase = ((params.alias as string | undefined) ?? "").trim();
  const dryRun = (params.dry_run as boolean | undefined) ?? false;

  if (!name) {
    return { content: "name is required.", isError: true };
  }
  if (deps.platform() !== "win32") {
    return {
      content: "launch_app is only implemented on Windows in this version. Tell the user honestly that you cannot open apps on this platform yet.",
      isError: true,
    };
  }

  const queryNorm = normalize(name);
  if (!queryNorm) {
    return { content: `'${name}' contains no searchable characters.`, isError: true };
  }

  // 1. Learned alias — deterministic, no model judgment, no ambiguity.
  const aliasStore = await loadAliases();
  const aliasHit = aliasStore.aliases[queryNorm];
  let resolution: Resolution;
  if (aliasHit) {
    resolution = { kind: "alias", app: { name: aliasHit.name, appId: aliasHit.appId } };
  } else {
    // 2. Registry match with confidence gate; on a total miss, rescan
    //    once (the app may have been installed since the last scan).
    let apps: InstalledApp[];
    try {
      apps = await getApps(false);
    } catch (err: unknown) {
      return { content: `Could not scan installed apps: ${formatErrorMessage(err)}`, isError: true };
    }
    resolution = resolveAgainst(apps, queryNorm);
    if (resolution.kind === "none") {
      const cached = await loadRegistry();
      const staleEnough = !cached || deps.now() - cached.scannedAt > REGISTRY_MISS_RESCAN_MIN_AGE_MS;
      if (staleEnough) {
        try {
          apps = await getApps(true);
          resolution = resolveAgainst(apps, queryNorm);
        } catch (err: unknown) {
          return { content: `Could not rescan installed apps: ${formatErrorMessage(err)}`, isError: true };
        }
      }
    }
  }

  if (resolution.kind === "none") {
    return {
      content: `No installed app matches '${name}'. Ask the user what app they mean — once they name it, call launch_app again with that exact name and alias='${name}' so it is remembered.`,
      outputs: { resolved: false, launched: false, candidates: [] },
    };
  }

  if (resolution.kind === "ambiguous") {
    const candidates = resolution.candidates!.map((c) => c.app.name);
    return {
      content:
        `'${name}' is ambiguous — do NOT guess. Ask the user which app they mean:\n` +
        candidates.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\nThen call launch_app again with the chosen exact name and alias='${name}' so the phrasing is remembered.`,
      outputs: { resolved: false, launched: false, candidates },
    };
  }

  const app = resolution.app!;

  if (dryRun) {
    return {
      content: `[dry run] Would launch '${app.name}' (AppID: ${app.appId}), resolved via ${resolution.kind === "alias" ? "learned alias" : "registry match"}. Nothing was launched.`,
      outputs: { resolved: true, launched: false, dryRun: true, app: app.name, appId: app.appId },
    };
  }

  try {
    await deps.spawnApp(app);
  } catch (err: unknown) {
    return {
      content: `Failed to launch '${app.name}': ${formatErrorMessage(err)}`,
      isError: true,
      outputs: { resolved: true, launched: false, app: app.name, appId: app.appId },
    };
  }

  // 3. Learn the phrasing AFTER a successful dispatch, never before.
  let learned = "";
  if (aliasPhrase && normalize(aliasPhrase) !== normalize(app.name)) {
    try {
      await saveAlias(aliasPhrase, app);
      learned = ` Remembered '${aliasPhrase}' → ${app.name}.`;
    } catch (err: unknown) {
      learned = ` (Could not save alias '${aliasPhrase}': ${formatErrorMessage(err)})`;
    }
  }

  return {
    content: `Launch dispatched: '${app.name}'.${learned} Note: dispatch succeeded, but window appearance is not verified — if the user says nothing opened, believe them.`,
    outputs: { resolved: true, launched: true, app: app.name, appId: app.appId },
  };
}

// ── Registration ──────────────────────────────────────────

export function registerLaunchAppTool(): void {
  registerToolHandler("launch_app", handleLaunchApp);

  registerPromptFragment({
    id: "tool:launch-app",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("launch_app"),
    order: 74,
    content: [
      "LAUNCHING APPS: Use launch_app to open desktop applications. Pass the",
      "user's phrasing as 'name' — resolution is handled deterministically.",
      "If the result lists candidate apps, relay the question to the user and",
      "wait; NEVER pick one yourself. When the user confirms which app they",
      "meant, call launch_app with that exact name and alias=<their original",
      "phrasing> so it resolves instantly next time. A success result means",
      "the launch was DISPATCHED, not that a window is verified on screen.",
    ].join("\n"),
  });

  logger.info({ tools: ["launch_app"] }, "launch_app tool registered");
}
