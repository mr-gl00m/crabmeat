/**
 * Built-in slash command handlers.
 *
 * These commands are user-facing and bypass the LLM entirely.
 * They're executed directly by the gateway when detected in chat.send content.
 */

import { registerCommand, listCommands, type CommandResult } from "./registry.js";
import { loadAgentIdentity, saveAgentIdentity } from "../agents/agent-identity.js";
import { getWorkspaceRoot } from "../agents/tools/builtins.js";
import { createScheduleStore } from "../scheduler/store.js";
import { checkLayer2Health, resetHealthCache } from "../agents/layer2/health.js";
import { estimateTokens } from "../agents/context.js";
import { compactHistory } from "../agents/compaction.js";
import { hasOutboundConnector, listOutboundConnectors } from "../connectors/outbound.js";
import type { Layer2Config } from "../config/types.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runDiagnostics, formatDiagnostics } from "./doctor.js";

// ── /help ───────────────────────────────────────────────

registerCommand({
  name: "help",
  description: "List all available slash commands",
  handler: async (_ctx): Promise<CommandResult> => {
    const cmds = listCommands();
    const lines = cmds.map((c) => {
      const usage = c.usage ? `  Usage: ${c.usage}` : "";
      return `  **/${c.name}** — ${c.description}${usage}`;
    });
    return {
      output: `**Available commands:**\n${lines.join("\n")}`,
    };
  },
});

// ── /clear ──────────────────────────────────────────────

registerCommand({
  name: "clear",
  description: "Clear the current session transcript",
  handler: async (ctx): Promise<CommandResult> => {
    const session = await ctx.store.load(ctx.sessionKey);
    if (!session) {
      return { output: "No active session to clear." };
    }

    const count = session.transcript.length;
    session.transcript = [];
    session.updatedAt = new Date().toISOString();
    await ctx.store.save(session);

    logger.info({ sessionKey: ctx.sessionKey, cleared: count }, "Session transcript cleared via /clear");
    return { output: `Cleared ${count} transcript entries from session.` };
  },
});

// ── /compact ────────────────────────────────────────────

registerCommand({
  name: "compact",
  description: "Force context compaction on the current session",
  handler: async (ctx): Promise<CommandResult> => {
    // Circuit breaker check — compaction calls the LLM
    if (ctx.circuitBreaker && !ctx.circuitBreaker.isAllowed()) {
      return { output: "Cannot compact: circuit breaker is tripped. Use `/reset` first." };
    }

    const session = await ctx.store.load(ctx.sessionKey);
    if (!session) {
      return { output: "No active session to compact." };
    }

    if (session.transcript.length < 4) {
      return { output: "Transcript too short to compact (need at least 4 entries)." };
    }

    // Get a provider for the compaction LLM call
    const providerConfig = ctx.config.providers[0];
    if (!providerConfig) {
      return { output: "No providers configured. Compaction requires at least one provider." };
    }

    const provider = ctx.pipeline.getProvider(providerConfig.id);
    if (!provider) {
      return { output: `Provider '${providerConfig.id}' not found in pipeline.` };
    }

    // Compute token budget from agent config
    const agent = ctx.config.agents.find((a) => a.id === session.agentId) ?? ctx.config.agents[0];
    const tokenBudget = agent
      ? (agent.contextWindowTokens ?? agent.maxTokens * 4)
      : 16384;

    const beforeCount = session.transcript.length;
    const beforeTokens = session.transcript.reduce(
      (sum, e) => sum + estimateTokens(e.content), 0,
    );

    try {
      session.transcript = await compactHistory(
        session.transcript,
        tokenBudget,
        provider,
        providerConfig.model,
        undefined,
        { sessionKey: ctx.sessionKey, trigger: "manual" },
      );

      const afterCount = session.transcript.length;
      const afterTokens = session.transcript.reduce(
        (sum, e) => sum + estimateTokens(e.content), 0,
      );

      await ctx.store.save(session);

      logger.info(
        { sessionKey: ctx.sessionKey, beforeCount, afterCount, beforeTokens, afterTokens },
        "Session compacted via /compact",
      );

      return {
        output: [
          "**Compaction complete:**",
          `  Entries: ${beforeCount} → ${afterCount}`,
          `  Tokens: ~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()}`,
        ].join("\n"),
      };
    } catch (err) {
      const msg = formatErrorMessage(err);
      logger.error({ error: msg, sessionKey: ctx.sessionKey }, "Compaction failed via /compact");
      return { output: `Compaction failed: ${msg}` };
    }
  },
});

// ── /model ──────────────────────────────────────────────────────

/**
 * Query Ollama's API for available and running models.
 * Returns null if Ollama isn't reachable.
 */
async function queryOllamaModels(baseUrl: string): Promise<{
  available: Array<{ name: string; size: number; modified: string }>;
  running: Set<string>;
} | null> {
  try {
    const ollamaBase = baseUrl.replace(/\/v1\/?$/, "");
    const [tagsRes, psRes] = await Promise.all([
      fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${ollamaBase}/api/ps`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
    ]);
    if (!tagsRes.ok) return null;
    const tagsData = (await tagsRes.json()) as {
      models: Array<{ name: string; size: number; modified_at: string }>;
    };
    const running = new Set<string>();
    if (psRes?.ok) {
      const psData = (await psRes.json()) as { models: Array<{ name: string }> };
      for (const m of psData.models ?? []) running.add(m.name);
    }
    return {
      available: (tagsData.models ?? []).map((m) => ({
        name: m.name, size: m.size, modified: m.modified_at,
      })),
      running,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a numeric model selector (`/model 1`, `/model swap 2`) to an
 * actual model name. Presets win over the dynamic Ollama index — that's
 * the whole point of presets, so `swap 1` always means "my favorite #1"
 * regardless of how Ollama orders its tag list today.
 *
 * When a preset is set we still validate against Ollama (if reachable)
 * so a typo'd preset surfaces as a clear "not pulled" error instead of
 * a 404 at inference time.
 */
async function resolveNumericModel(
  num: number,
  ctx: { config: { providers: Array<{ baseUrl?: string }>; modelPresets?: Record<string, string> } },
  baseUrl: string | undefined,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const presets = ctx.config.modelPresets ?? {};
  const presetName = presets[String(num)];

  if (presetName) {
    if (baseUrl) {
      const result = await queryOllamaModels(baseUrl);
      if (result && !result.available.some((m) => m.name === presetName)) {
        const names = result.available.map((m) => m.name);
        return {
          ok: false,
          message: `**Preset ${num} → '${presetName}' not pulled.** Available:\n${names.map((n) => `  - ${n}`).join("\n")}\n\nPull it with: \`ollama pull ${presetName}\` or update \`modelPresets\` in your config.`,
        };
      }
    }
    return { ok: true, name: presetName };
  }

  // No preset configured for this slot — fall back to dynamic index.
  if (!baseUrl) {
    return { ok: false, message: "**No local provider configured.** Use `/model swap <name>` or set `modelPresets` in your config." };
  }
  const result = await queryOllamaModels(baseUrl);
  if (!result) {
    return { ok: false, message: "**Could not reach Ollama.** Is it running?" };
  }
  if (num > result.available.length) {
    return { ok: false, message: `**Invalid selection.** Only ${result.available.length} models available. Use \`/model list\`.` };
  }
  return { ok: true, name: result.available[num - 1]!.name };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

registerCommand({
  name: "model",
  description: "Show, list, or swap models; toggle Layer 2",
  usage: "/model [list | swap <name|number> | <number> | layer2 enable|disable|status]",
  handler: async (ctx): Promise<CommandResult> => {
    const args = ctx.args.trim();
    const argsLower = args.toLowerCase();
    const l2Config = ctx.config.layer2 as Layer2Config;

    // ── /model layer2 enable ───────────────────────────
    if (argsLower === "layer2 enable") {
      if (!l2Config.providerId) {
        return { output: "**Error:** No Layer 2 provider configured. Set `layer2.providerId` in config first." };
      }
      const session = await ctx.store.load(ctx.sessionKey);
      if (session) {
        session.layer2Override = { enabled: true };
        await ctx.store.save(session);
      }
      resetHealthCache(l2Config.providerId);
      return { output: "**Layer 2** enabled for this session. Local model will handle disambiguation requests." };
    }

    // ── /model layer2 disable ──────────────────────────
    if (argsLower === "layer2 disable") {
      const session = await ctx.store.load(ctx.sessionKey);
      if (session) {
        session.layer2Override = { enabled: false };
        await ctx.store.save(session);
      }
      return { output: "**Layer 2** disabled for this session. All requests go directly to frontier model." };
    }

    // ── /model layer2 status ───────────────────────────
    if (argsLower === "layer2 status") {
      const lines: string[] = ["**Layer 2 Status:**"];
      lines.push(`  Config enabled: ${l2Config.enabled}`);
      lines.push(`  Provider ID: ${l2Config.providerId || "(not set)"}`);
      lines.push(`  Confidence band: ${l2Config.confidenceThreshold}–${l2Config.confidenceCeiling}`);
      lines.push(`  Max tokens: ${l2Config.maxTokens}`);

      const session = await ctx.store.load(ctx.sessionKey);
      if (session?.layer2Override?.enabled !== undefined) {
        lines.push(`  Session override: ${session.layer2Override.enabled ? "enabled" : "disabled"}`);
      }

      if (l2Config.providerId) {
        const provider = ctx.pipeline.getProvider(l2Config.providerId);
        if (provider) {
          const healthy = await checkLayer2Health(provider, l2Config.healthCheckTimeoutMs);
          lines.push(`  Health: ${healthy ? "**healthy**" : "**unhealthy** (model may be offline)"}`);
        } else {
          lines.push(`  Health: **provider not found** (ID: ${l2Config.providerId})`);
        }
      }

      return { output: lines.join("\n") };
    }

    // ── /model list — query Ollama for available models ─
    if (argsLower === "list") {
      const provider = ctx.config.providers[0];
      if (!provider?.baseUrl) {
        return { output: "**No local provider with baseUrl configured.** Can only list models for Ollama-compatible providers." };
      }

      const result = await queryOllamaModels(provider.baseUrl);
      if (!result) {
        return { output: "**Could not reach Ollama.** Is it running? Check `ollama serve`." };
      }

      if (result.available.length === 0) {
        return { output: "**No models found.** Pull one with `ollama pull <model>`." };
      }

      const current = provider.model;
      const lines: string[] = [];

      // Render presets first when configured. Presets are stable user
      // shortcuts (slot 1–9 → model name) and take precedence over the
      // dynamic Ollama index below, so showing them at the top makes the
      // mapping obvious. Pinning each preset to its current/loaded state
      // helps the user spot a typo'd preset (e.g. an "active" marker
      // missing because the preset references a model that was renamed).
      const presets = ctx.config.modelPresets ?? {};
      const presetEntries = Object.entries(presets)
        .filter(([k]) => /^[1-9]$/.test(k))
        .sort(([a], [b]) => Number(a) - Number(b));
      if (presetEntries.length > 0) {
        lines.push("**Presets:** (use `/model <number>`)");
        for (const [slot, name] of presetEntries) {
          const found = result.available.find((m) => m.name === name);
          const isCurrent = name === current;
          let suffix = "";
          if (!found) suffix = " ⚠ not pulled";
          else if (isCurrent) suffix = " ← **active**";
          else if (result.running.has(name)) suffix = " (loaded)";
          lines.push(`  ${slot}. ${name}${suffix}`);
        }
        lines.push("");
      }

      lines.push("**Available models:**", "");
      for (let i = 0; i < result.available.length; i++) {
        const m = result.available[i]!;
        const isCurrent = m.name === current;
        const isRunning = result.running.has(m.name);
        const size = formatBytes(m.size);

        let status = "";
        if (isCurrent) status = " ← **active**";
        else if (isRunning) status = " (loaded)";

        lines.push(`  ${i + 1}. ${m.name}  ${size}${status}`);
      }

      lines.push("", `Swap with: \`/model swap <name>\` or \`/model <number>\``);
      return { output: lines.join("\n") };
    }

    // ── /model swap|switch|use <name|number> — hot-swap the active model ──
    const swapMatch = /^(?:swap|switch|use)\s*/i.exec(argsLower);
    if (swapMatch) {
      const swapArg = args.slice(swapMatch[0].length).trim();
      if (!swapArg) {
        return { output: "**Usage:** `/model swap <name|number>` — use `/model list` to see available models and presets." };
      }

      const provider = ctx.config.providers[0];
      if (!provider) {
        return { output: "**Error:** No provider configured." };
      }

      // Numeric input → delegate to preset-or-index resolver below.
      // The whole point of `/model swap 1` is the same QoL as `/model 1`,
      // and the user's mental model is "swap to slot 1", so the two
      // syntaxes should be identical in behavior.
      let modelName: string;
      const swapNum = parseInt(swapArg, 10);
      if (!isNaN(swapNum) && String(swapNum) === swapArg && swapNum > 0) {
        const resolved = await resolveNumericModel(swapNum, ctx, provider.baseUrl);
        if (!resolved.ok) return { output: resolved.message };
        modelName = resolved.name;
      } else {
        modelName = swapArg;
        // Validate the named model exists if Ollama is reachable
        if (provider.baseUrl) {
          const result = await queryOllamaModels(provider.baseUrl);
          if (result) {
            const exists = result.available.some((m) => m.name === modelName);
            if (!exists) {
              const names = result.available.map((m) => m.name);
              return {
                output: `**Model '${modelName}' not found.** Available:\n${names.map((n) => `  - ${n}`).join("\n")}\n\nPull it with: \`ollama pull ${modelName}\``,
              };
            }
          }
        }
      }

      const oldModel = provider.model;
      (provider as { model: string }).model = modelName;

      // Wipe any cooldown the previous model left behind. Without this,
      // swapping out of a broken model still leaves the provider in
      // cooldown for up to 30s and every request fails with "All
      // providers are unavailable" — confusing and exactly what the
      // user is trying to escape by swapping.
      ctx.pipeline.resetProviderCooldowns();

      logger.info(
        { oldModel, newModel: modelName, providerId: provider.id },
        "Model hot-swapped via /model swap",
      );

      return {
        output: `**Model swapped:** ${oldModel} → **${modelName}**\n\nNext message will use the new model. This change is session-only — restart reverts to config.`,
      };
    }

    // ── /model <number> — preset (if configured) or dynamic index from /model list ─
    const num = parseInt(args, 10);
    if (!isNaN(num) && String(num) === args && num > 0) {
      const provider = ctx.config.providers[0];
      if (!provider) {
        return { output: "**Error:** No provider configured." };
      }
      const resolved = await resolveNumericModel(num, ctx, provider.baseUrl);
      if (!resolved.ok) return { output: resolved.message };

      const modelName = resolved.name;
      const oldModel = provider.model;
      (provider as { model: string }).model = modelName;
      ctx.pipeline.resetProviderCooldowns();

      logger.info(
        { oldModel, newModel: modelName, providerId: provider.id },
        "Model hot-swapped via /model <number>",
      );

      return {
        output: `**Model swapped:** ${oldModel} → **${modelName}**`,
      };
    }

    // ── Default: show current config ──────────────────────
    const providers = ctx.config.providers.map((p) => {
      const base = p.baseUrl ? ` (${p.baseUrl})` : "";
      return `  **${p.id}** — ${p.type}/${p.model}${base}`;
    });

    const l2Enabled = l2Config.enabled;
    const l2Status = l2Enabled
      ? `enabled (provider: ${l2Config.providerId || "not set"})`
      : "disabled";

    const hasOllama = ctx.config.providers.some((p) => p.baseUrl?.includes("ollama") || p.baseUrl?.includes("11434"));
    const hint = hasOllama ? "\n\nUse `/model list` to see available models, `/model swap <name>` to switch." : "";

    return {
      output: `**Current model:** ${ctx.config.providers[0]?.model ?? "none"}\n\n**Configured providers:**\n${providers.join("\n")}\n\n**Layer 2:** ${l2Status}${hint}`,
    };
  },
});

// ── /sessions ───────────────────────────────────────────

registerCommand({
  name: "sessions",
  description: "List active sessions",
  handler: async (ctx): Promise<CommandResult> => {
    const keys = await ctx.store.list();
    if (keys.length === 0) {
      return { output: "No active sessions." };
    }
    const lines = keys.map((k) => `  - ${k}`);
    return {
      output: `**Active sessions (${keys.length}):**\n${lines.join("\n")}`,
    };
  },
});

// ── /identity ───────────────────────────────────────────

registerCommand({
  name: "identity",
  description: "Show or edit AGENT.json identity",
  usage: "/identity [set key=value]",
  handler: async (ctx): Promise<CommandResult> => {
    const wsRoot = getWorkspaceRoot();

    if (!ctx.args || ctx.args === "") {
      // Show current identity
      const identity = await loadAgentIdentity(wsRoot);
      if (!identity) {
        return { output: "No AGENT.json found. The agent has no configured identity." };
      }
      return { output: `**Agent Identity:**\n\`\`\`json\n${JSON.stringify(identity, null, 2)}\n\`\`\`` };
    }

    // Parse "set key=value" syntax
    const setMatch = ctx.args.match(/^set\s+(\w+)\s*=\s*(.+)$/i);
    if (!setMatch) {
      return { output: "Usage: `/identity` to view, `/identity set key=value` to update a field." };
    }

    const [, key, rawValue] = setMatch;
    let value: unknown;
    try {
      value = JSON.parse(rawValue!);
    } catch {
      value = rawValue; // Treat as string if not valid JSON
    }

    const existing = (await loadAgentIdentity(wsRoot)) ?? {};
    (existing as Record<string, unknown>)[key!] = value;
    await saveAgentIdentity(wsRoot, existing);

    return { output: `Updated AGENT.json: **${key}** = \`${JSON.stringify(value)}\`` };
  },
});

// ── /kill ───────────────────────────────────────────────

registerCommand({
  name: "kill",
  description: "Trip the circuit breaker — halts all AI inference",
  handler: async (ctx): Promise<CommandResult> => {
    if (!ctx.circuitBreaker) {
      return { output: "No circuit breaker configured." };
    }
    ctx.circuitBreaker.trip();
    logger.warn({ source: "slash-command" }, "Circuit breaker tripped via /kill");
    return { output: "**[KILL SWITCH ENGAGED]** Circuit breaker tripped. AI inference is halted. Use `/reset` to re-enable." };
  },
});

// ── /reset ──────────────────────────────────────────────

registerCommand({
  name: "reset",
  description: "Reset the circuit breaker — re-enables AI inference",
  handler: async (ctx): Promise<CommandResult> => {
    if (!ctx.circuitBreaker) {
      return { output: "No circuit breaker configured." };
    }
    ctx.circuitBreaker.reset();
    logger.info({ source: "slash-command" }, "Circuit breaker reset via /reset");
    return { output: "**[RESET]** Circuit breaker reset. AI inference is re-enabled." };
  },
});

// ── /status ─────────────────────────────────────────────

registerCommand({
  name: "status",
  description: "Show system status (breaker, sessions, model, layers, tasks, schedules)",
  handler: async (ctx): Promise<CommandResult> => {
    const sessionKeys = await ctx.store.list();
    const breakerState = ctx.circuitBreaker
      ? (ctx.circuitBreaker.isAllowed() ? "closed (normal)" : "OPEN (inference halted)")
      : "not configured";

    const providerCount = ctx.config.providers.length;
    const agentCount = ctx.config.agents.length;
    const toolCount = ctx.config.tools.length;
    const primaryModel = ctx.config.providers[0]
      ? `${ctx.config.providers[0].id} / ${ctx.config.providers[0].model}`
      : "(none)";

    const lines: string[] = [
      "**System Status:**",
      `  Circuit breaker: ${breakerState}`,
      `  Primary model: ${primaryModel}`,
      `  Active sessions: ${sessionKeys.length}`,
      `  Providers: ${providerCount} | Agents: ${agentCount} | Tools: ${toolCount}`,
      `  Arbiter: enabled (deterministic intent gate)`,
      `  Layer 2: ${ctx.config.layer2.enabled ? `enabled (${(ctx.config.layer2 as Layer2Config).providerId || "no provider"})` : "disabled"}`,
    ];

    // Current session token count
    const session = await ctx.store.load(ctx.sessionKey);
    if (session) {
      const tokenCount = session.transcript.reduce(
        (sum, e) => sum + estimateTokens(e.content), 0,
      );
      const entryCount = session.transcript.length;
      const agent = ctx.config.agents.find((a) => a.id === session.agentId) ?? ctx.config.agents[0];
      const budget = agent ? (agent.contextWindowTokens ?? agent.maxTokens * 4) : 0;
      const pct = budget > 0 ? Math.round((tokenCount / budget) * 100) : 0;
      lines.push(`  Session: ${entryCount} entries, ~${tokenCount.toLocaleString()} tokens (${pct}% of budget)`);
    }

    // Active tasks count
    try {
      const tasksRaw = await readFile(join(getWorkspaceRoot(), ".crabmeat", "tasks.json"), "utf-8");
      const tasksData = JSON.parse(tasksRaw) as { lists?: Array<{ items?: Array<{ done?: boolean }> }> };
      const lists = tasksData.lists ?? [];
      const pending = lists.reduce(
        (sum, l) => sum + (l.items?.filter((i) => !i.done).length ?? 0), 0,
      );
      if (lists.length > 0) {
        lines.push(`  Task lists: ${lists.length} (${pending} pending items)`);
      }
    } catch { /* no tasks file */ }

    // Active schedules count
    try {
      const schedStore = createScheduleStore(getWorkspaceRoot());
      const schedules = await schedStore.loadAll();
      const active = schedules.filter((s) => s.enabled).length;
      if (schedules.length > 0) {
        lines.push(`  Schedules: ${schedules.length} total, ${active} active`);
      }
    } catch { /* no schedules */ }

    return { output: lines.join("\n") };
  },
});

// ── /schedules ──────────────────────────────────────────

registerCommand({
  name: "schedules",
  description: "List all scheduled tasks with status and timing",
  handler: async (_ctx): Promise<CommandResult> => {
    const store = createScheduleStore(getWorkspaceRoot());
    const schedules = await store.loadAll();

    if (schedules.length === 0) {
      return { output: "No scheduled tasks. The agent can create them with `schedule_task`." };
    }

    const lines = schedules.map((s) => {
      const status = s.enabled ? "active" : "paused";
      const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never";
      const nextRun = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "unknown";
      return `  **${s.name}** (\`${s.id}\`) [${status}]\n    Cron: \`${s.cron}\` | Last: ${lastRun} | Next: ${nextRun}`;
    });

    return { output: `**Scheduled tasks (${schedules.length}):**\n\n${lines.join("\n\n")}` };
  },
});

// ── /doctor ────────────────────────────────────────────

registerCommand({
  name: "doctor",
  description: "Run system diagnostics (providers, config, sessions, schedules, disk)",
  handler: async (ctx): Promise<CommandResult> => {
    const results = await runDiagnostics(ctx);
    return { output: formatDiagnostics(results) };
  },
});

// ── /away ──────────────────────────────────────────────
//
// Tell the agent the user is leaving the CLI. Until /back is issued,
// every turn injects an [AWAY MODE] notice into the dynamic prompt
// region instructing the model to deliver its final response via
// message_send to the preferred outbound connector. This means the
// user can ask a long-running question, walk away, and still get the
// answer pushed to Discord (or whichever connector is wired up).
//
// Usage:
//   /away                  → use the default connector (first registered)
//   /away discord          → pin to a specific connector by id
//   /away discord in a meeting until 3   → also record a reason

registerCommand({
  name: "away",
  description: "Mark yourself as away. The agent will deliver final responses via the preferred connector.",
  usage: "/away [connector] [reason...]",
  handler: async (ctx): Promise<CommandResult> => {
    const session = await ctx.store.load(ctx.sessionKey);
    if (!session) {
      return { output: "No active session to mark as away." };
    }

    const args = ctx.args.trim();
    let preferredConnector: string | undefined;
    let reason: string | undefined;

    if (args.length > 0) {
      // First token is treated as a connector id IF it matches a registered
      // connector. Otherwise the entire arg string is the reason and we fall
      // back to the default connector below. This avoids surprising the user
      // when they type `/away grabbing lunch` and we mistake "grabbing" for
      // a connector id.
      const [first, ...rest] = args.split(/\s+/);
      if (first && hasOutboundConnector(first)) {
        preferredConnector = first;
        if (rest.length > 0) reason = rest.join(" ");
      } else {
        reason = args;
      }
    }

    if (!preferredConnector) {
      const registered = listOutboundConnectors();
      if (registered.length > 0) {
        preferredConnector = registered[0]!.id;
      }
    }

    session.awayMode = {
      enabled: true,
      preferredConnector,
      setAt: new Date().toISOString(),
      reason,
    };
    await ctx.store.save(session);

    logger.info(
      { sessionKey: ctx.sessionKey, preferredConnector, reason },
      "Session marked as away via /away",
    );

    const lines: string[] = ["**[AWAY MODE ON]**"];
    if (preferredConnector) {
      lines.push(`Final responses will be delivered via **${preferredConnector}**.`);
    } else {
      lines.push("**Warning:** no outbound connector is registered. The agent will know you're away but cannot reach you externally. Configure one (e.g. `connectors.discord.webhookUrl`) and try again.");
    }
    if (reason) lines.push(`Reason: _${reason}_`);
    lines.push("Use `/back` to return.");
    return { output: lines.join("\n") };
  },
});

// ── /back ──────────────────────────────────────────────

registerCommand({
  name: "back",
  description: "Clear away mode — you're back at the CLI.",
  handler: async (ctx): Promise<CommandResult> => {
    const session = await ctx.store.load(ctx.sessionKey);
    if (!session) {
      return { output: "No active session." };
    }

    if (!session.awayMode?.enabled) {
      return { output: "Not currently in away mode." };
    }

    session.awayMode = { enabled: false };
    await ctx.store.save(session);

    logger.info({ sessionKey: ctx.sessionKey }, "Away mode cleared via /back");
    return { output: "**[AWAY MODE OFF]** Welcome back. Final responses will appear here in the chat window again." };
  },
});

