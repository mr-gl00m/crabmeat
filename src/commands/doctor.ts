/**
 * /doctor — System diagnostics.
 *
 * Validates configuration, checks provider connectivity,
 * inspects session health, and surfaces potential issues.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandContext } from "./registry.js";
import { checkLayer2Health } from "../agents/layer2/health.js";
import { hasToolHandler } from "../agents/tools/handlers.js";
import { createScheduleStore } from "../scheduler/store.js";
import { getWorkspaceRoot } from "../agents/tools/builtins.js";
import type { Layer2Config } from "../config/types.js";
import { expandFileAccessPresets } from "../config/schema.js";
import { formatErrorMessage } from "../infra/errors.js";

export interface DiagnosticResult {
  label: string;
  status: "ok" | "warn" | "error";
  message: string;
}

const STATUS_ICON = { ok: "[OK]  ", warn: "[WARN]", error: "[ERR] " } as const;

export function formatDiagnostics(results: DiagnosticResult[]): string {
  if (results.length === 0) return "No diagnostics to report.";

  const lines = results.map(
    (r) => `${STATUS_ICON[r.status]} ${r.label}: ${r.message}`,
  );

  const counts = { ok: 0, warn: 0, error: 0 };
  for (const r of results) counts[r.status]++;

  const summary = `\n**Summary:** ${counts.ok} ok, ${counts.warn} warnings, ${counts.error} errors`;
  return `**Diagnostics:**\n${lines.join("\n")}${summary}`;
}

// ── Individual checks ──────────────────────────────────

export async function checkProviders(ctx: CommandContext): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const TIMEOUT = 5000;

  for (const pc of ctx.config.providers) {
    const provider = ctx.pipeline.getProvider(pc.id);
    if (!provider) {
      results.push({ label: `Provider ${pc.id}`, status: "error", message: "not found in pipeline" });
      continue;
    }

    const start = Date.now();
    try {
      const healthy = await checkLayer2Health(provider, TIMEOUT);
      const ms = Date.now() - start;
      if (healthy) {
        results.push({ label: `Provider ${pc.id}`, status: "ok", message: `healthy (${ms}ms)` });
      } else {
        results.push({ label: `Provider ${pc.id}`, status: "error", message: `unreachable (${ms}ms)` });
      }
    } catch {
      const ms = Date.now() - start;
      results.push({ label: `Provider ${pc.id}`, status: "error", message: `failed (${ms}ms)` });
    }
  }

  if (ctx.config.providers.length === 0) {
    results.push({ label: "Providers", status: "error", message: "no providers configured" });
  }

  return results;
}

export async function checkLayer2(ctx: CommandContext): Promise<DiagnosticResult[]> {
  const l2 = ctx.config.layer2 as Layer2Config;
  if (!l2.enabled) return [];

  if (!l2.providerId) {
    return [{ label: "Layer 2", status: "error", message: "enabled but no providerId set" }];
  }

  const provider = ctx.pipeline.getProvider(l2.providerId);
  if (!provider) {
    return [{ label: "Layer 2", status: "error", message: `provider '${l2.providerId}' not found` }];
  }

  const healthy = await checkLayer2Health(provider, l2.healthCheckTimeoutMs);
  return [{
    label: "Layer 2",
    status: healthy ? "ok" : "error",
    message: healthy ? "local model reachable" : "local model unreachable",
  }];
}

export function checkConfigWarnings(ctx: CommandContext): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];

  // Auth mode
  if (ctx.config.gateway.auth.mode === "none") {
    results.push({ label: "Auth", status: "warn", message: "auth mode is 'none' — gateway is unauthenticated" });
  }

  // Gateway bind host — warn if not localhost. Exposing the gateway to
  // LAN/0.0.0.0 without TLS is the #1 deployment footgun.
  const host = ctx.config.gateway.host;
  if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    results.push({
      label: "Gateway host",
      status: "warn",
      message: `bound to '${host}' — front with TLS/reverse-proxy or use 127.0.0.1`,
    });
  }

  // File access paths
  const expandedPresetPaths = expandFileAccessPresets(ctx.config.fileAccessPresets);
  if (ctx.config.fileAccessPaths.length === 0 && expandedPresetPaths.length === 0) {
    results.push({ label: "File access", status: "warn", message: "only the workspace is reachable; add fileAccessPresets or fileAccessPaths for remote file work" });
  }
  for (const p of [...ctx.config.fileAccessPaths, ...expandedPresetPaths]) {
    const normalized = p.replace(/\\/g, "/").toLowerCase();
    if (normalized === "/" || normalized === "c:/" || normalized === "c:\\") {
      results.push({ label: "File access", status: "warn", message: `overly broad path: '${p}' (root access)` });
    }
  }

  // Providers missing an apiKey — cloud providers will fail at first
  // request with a confusing 401 if the secret reference isn't set.
  for (const pc of ctx.config.providers) {
    const needsKey = pc.type === "anthropic" || pc.type === "openai";
    if (!needsKey) continue;
    const ref = (pc as { apiKey?: string }).apiKey;
    if (!ref) {
      results.push({
        label: `Provider ${pc.id}`,
        status: "warn",
        message: `missing apiKey — requests will fail with auth error`,
      });
      continue;
    }
    // If it's a $SECRET:NAME reference, verify the env var is actually set.
    const secretMatch = /^\$SECRET:(.+)$/.exec(ref);
    if (secretMatch && !process.env[secretMatch[1]!]) {
      results.push({
        label: `Provider ${pc.id}`,
        status: "warn",
        message: `apiKey references unset secret '${secretMatch[1]}'`,
      });
    }
  }

  // Tools without handlers
  for (const tool of ctx.config.tools) {
    if (!hasToolHandler(tool.id)) {
      results.push({ label: `Tool ${tool.id}`, status: "warn", message: "no handler registered" });
    }
  }

  // Agents referencing tools not in config
  const toolIds = new Set(ctx.config.tools.map((t) => t.id));
  for (const agent of ctx.config.agents) {
    for (const toolId of agent.tools) {
      if (!toolIds.has(toolId)) {
        results.push({ label: `Agent ${agent.id}`, status: "warn", message: `references undefined tool '${toolId}'` });
      }
    }
  }

  if (results.length === 0) {
    results.push({ label: "Config", status: "ok", message: "no issues detected" });
  }

  return results;
}

export async function checkSessionHealth(ctx: CommandContext): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const maxEntries = ctx.config.session.maxTranscriptEntries ?? 200;
  const retentionDays = ctx.config.session.retentionDays ?? 30;
  const now = Date.now();

  try {
    const keys = await ctx.store.list();
    let oversized = 0;
    let expired = 0;

    for (const key of keys) {
      const session = await ctx.store.load(key);
      if (!session) continue;

      if (session.transcript.length > maxEntries * 0.8) {
        oversized++;
      }

      const age = now - new Date(session.updatedAt).getTime();
      if (age > retentionDays * 86_400_000) {
        expired++;
      }
    }

    if (oversized > 0) {
      results.push({ label: "Sessions", status: "warn", message: `${oversized} session(s) at >80% transcript capacity` });
    }
    if (expired > 0) {
      results.push({ label: "Sessions", status: "warn", message: `${expired} session(s) past retention period` });
    }
    if (oversized === 0 && expired === 0) {
      results.push({ label: "Sessions", status: "ok", message: `${keys.length} session(s), all healthy` });
    }
  } catch (err) {
    results.push({ label: "Sessions", status: "error", message: `failed to check: ${formatErrorMessage(err)}` });
  }

  return results;
}

export async function checkScheduleHealth(ctx: CommandContext): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const agentIds = new Set(ctx.config.agents.map((a) => a.id));

  try {
    const store = createScheduleStore(getWorkspaceRoot());
    const schedules = await store.loadAll();

    if (schedules.length === 0) {
      return [{ label: "Schedules", status: "ok", message: "none configured" }];
    }

    let badAgent = 0;
    for (const s of schedules) {
      if (s.agentId && !agentIds.has(s.agentId)) {
        badAgent++;
      }
    }

    if (badAgent > 0) {
      results.push({ label: "Schedules", status: "warn", message: `${badAgent} schedule(s) reference nonexistent agent` });
    } else {
      results.push({ label: "Schedules", status: "ok", message: `${schedules.length} schedule(s), all valid` });
    }
  } catch {
    results.push({ label: "Schedules", status: "ok", message: "none configured" });
  }

  return results;
}

/**
 * Inspect the audit log's persistence health surface. Surfaces three
 * failure modes that would otherwise hide in pino logs:
 *
 *   1. last disk flush failed (lastFlushOk === false) — the audit
 *      chain is no longer reaching disk; entries persist only in
 *      memory and a crash would lose them.
 *   2. pendingWrites is high (>50) — the threshold flush isn't firing
 *      or is consistently failing, queue is building up.
 *   3. persist disabled — operator clarity. In-memory only is a valid
 *      mode (tests, ephemeral runs); we just say so explicitly.
 *
 * Without this surface, the operator's first hint of an audit-flush
 * problem is forensic — they'd notice missing entries during an
 * incident review. By then the cause is already off the screen.
 */
export function checkAuditHealth(ctx: CommandContext): DiagnosticResult[] {
  const auditLog = ctx.pipeline.auditLog;
  if (!auditLog || typeof auditLog.getStatus !== "function") {
    // Older pipelines or test harnesses might not surface getStatus.
    // Don't error — just stay quiet.
    return [];
  }
  const status = auditLog.getStatus();

  const results: DiagnosticResult[] = [];

  if (!status.persistEnabled) {
    results.push({
      label: "Audit log",
      status: "ok",
      message: "in-memory only (persist disabled) — entries do not survive restart",
    });
    return results;
  }

  if (status.lastFlushOk === false) {
    results.push({
      label: "Audit log",
      status: "error",
      message: `last flush failed at ${status.lastFlushAt ?? "(unknown)"}: ${status.lastFlushError ?? "(no detail)"} — entries retained in memory, persistence is broken`,
    });
    return results;
  }

  if (status.pendingWrites > 50) {
    results.push({
      label: "Audit log",
      status: "warn",
      message: `${status.pendingWrites} entries queued for disk flush — threshold flush may not be firing`,
    });
    return results;
  }

  if (status.lastFlushOk === null) {
    // Cold start, no flush yet. Not a problem on its own — record() and
    // the threshold flush handle this lazily. Surface as info.
    results.push({
      label: "Audit log",
      status: "ok",
      message: `persist enabled, ${status.totalEntries} entries, no flush yet (cold start)`,
    });
    return results;
  }

  results.push({
    label: "Audit log",
    status: "ok",
    message: `persist healthy, ${status.totalEntries} entries, last flush ${status.lastFlushAt ?? "(unknown)"}`,
  });
  return results;
}

export async function checkDiskUsage(): Promise<DiagnosticResult[]> {
  const wsRoot = getWorkspaceRoot();
  const clawDir = join(wsRoot, ".crabmeat");

  try {
    let totalBytes = 0;
    let fileCount = 0;

    async function walk(dir: string): Promise<void> {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          try {
            const s = await stat(full);
            totalBytes += s.size;
            fileCount++;
          } catch { /* skip */ }
        }
      }
    }

    await walk(clawDir);

    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    const status = totalBytes > 100 * 1024 * 1024 ? "warn" : "ok";
    return [{ label: "Disk (.crabmeat/)", status, message: `${mb} MB across ${fileCount} files` }];
  } catch {
    return [{ label: "Disk (.crabmeat/)", status: "ok", message: "directory not found" }];
  }
}

// ── Release-gate checks (Phase 4.18.2 — `crabmeat doctor --strict`) ──
//
// Stricter checks than checkConfigWarnings, intended to run *outside*
// the gateway (CI / pre-release / cold start) and exit non-zero on
// fail. The bar is "this config is safe to publicly expose," which is
// stricter than "this config will work for local dev."
//
// The set of checks here is small on purpose. Each one mirrors a
// release-gate footgun that has bitten or come close in past audits:
//   - auth=none on a publicly-bindable host
//   - admin enabled but no publicBaseUrl when external connectors are
//     configured (kill-links can't be constructed → a runaway agent
//     can't be reined in by the recipient)
//   - webhooks enabled with requireSecret=false (open POST endpoint)
//   - gateway bound to a non-loopback host without TLS configured
//
// Schema-level concerns (broad fileAccessPaths, deprecated layer0
// blocks) are already caught at config-load time by 4.17 and 4.18.4
// respectively — those don't need re-checking here.
export interface ReleaseGateOptions {
  /** True when an external connector (email, future Discord, etc.) is configured. */
  externalConnectorsEnabled: boolean;
}

export function checkReleaseGate(
  config: import("../config/types.js").Config,
  opts?: ReleaseGateOptions,
): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];

  // Auth: 'none' is acceptable for local-only dev, NEVER for a release
  // candidate. The schema permits it (because dev needs it); release-
  // gate doctor refuses it.
  if (config.gateway.auth.mode === "none") {
    results.push({
      label: "Auth (release gate)",
      status: "error",
      message: "auth.mode='none' — release configs MUST set auth.mode='token' or 'password'. Generate a token with `crabmeat setup` or set CRABMEAT_TOKEN.",
    });
  } else if (config.gateway.auth.mode === "token") {
    const token = config.gateway.auth.token ?? process.env.CRABMEAT_TOKEN;
    if (!token || token.length < 32) {
      results.push({
        label: "Auth token (release gate)",
        status: "error",
        message: "auth.mode='token' but no CRABMEAT_TOKEN env or gateway.auth.token (>=32 chars) configured.",
      });
    }
  }

  // Gateway bind host: any non-loopback bind without TLS is a release
  // blocker. The friendly checkConfigWarnings warns; release-gate hard-
  // fails because operators routinely overlook the warning.
  const host = config.gateway.host;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback && !config.gateway.tls) {
    results.push({
      label: "Gateway host (release gate)",
      status: "error",
      message: `gateway.host='${host}' is non-loopback AND gateway.tls is unset. Front with TLS or bind to 127.0.0.1.`,
    });
  }

  // Admin without publicBaseUrl when external connectors are present:
  // kill-links can't be constructed, so a runaway autonomous send has
  // no recipient-side recall path. The check needs to know whether any
  // external connector is configured because kill-links are only
  // emitted on outbound channels that go to humans (CLI doesn't need
  // them).
  const externalConnectors = opts?.externalConnectorsEnabled
    ?? Boolean(config.connectors.emailImap);
  if (config.admin.enabled && externalConnectors && !config.admin.publicBaseUrl) {
    results.push({
      label: "Admin publicBaseUrl (release gate)",
      status: "error",
      message: "admin.enabled=true with an external connector configured, but admin.publicBaseUrl is unset — message_send cannot construct kill-links and recipients cannot recall a runaway agent.",
    });
  }

  // Webhooks enabled with secrets explicitly disabled is an open
  // unauthenticated POST receiver. The schema permits requireSecret=false
  // because some testing setups need it; release-gate refuses.
  if (config.webhooks.enabled && config.webhooks.requireSecret === false) {
    results.push({
      label: "Webhooks (release gate)",
      status: "error",
      message: "webhooks.enabled=true with webhooks.requireSecret=false — every webhook URL would accept unauthenticated POST. Set requireSecret=true.",
    });
  }

  return results;
}

// ── Run all checks ─────────────────────────────────────

export async function runDiagnostics(ctx: CommandContext): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // Run config checks (synchronous) first
  results.push(...checkConfigWarnings(ctx));
  results.push(...checkAuditHealth(ctx));

  // Run async checks in parallel
  const [providers, layer2, sessions, schedules, disk] = await Promise.all([
    checkProviders(ctx),
    checkLayer2(ctx),
    checkSessionHealth(ctx),
    checkScheduleHealth(ctx),
    checkDiskUsage(),
  ]);

  results.push(...providers, ...layer2, ...sessions, ...schedules, ...disk);
  return results;
}
