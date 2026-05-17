import { z } from "zod";
import { normalize, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { hooksConfigSchema } from "../hooks/config.js";

export const FILE_ACCESS_PRESETS = [
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "music",
  "videos",
] as const;

export type FileAccessPreset = (typeof FILE_ACCESS_PRESETS)[number];

const FILE_ACCESS_PRESET_DIRS: Record<FileAccessPreset, string> = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
  pictures: "Pictures",
  music: "Music",
  videos: "Videos",
};

/**
 * Expand opt-in common-folder presets into absolute subdirectories of the
 * current user's home directory. This is intentionally narrower than "home":
 * each preset is a concrete child folder, so the same root/home rejection
 * discipline from fileAccessPaths still applies.
 */
export function expandFileAccessPresets(
  presets: readonly FileAccessPreset[],
): string[] {
  const home = homedir();
  if (!home) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const preset of presets) {
    const resolved = resolvePath(home, FILE_ACCESS_PRESET_DIRS[preset]);
    const key = resolvePath(resolved).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

// RT-2026-05-01-006: fileAccessPaths is a tired-operator footgun. The schema
// previously accepted any string; the file-tool jail then trusted every entry
// as an allowed root. A misconfigured "C:/" or "/" turns file_read/file_write
// into host-wide tools.
//
// Reject entries that are:
//   - not strings, empty, or whitespace-only
//   - non-absolute
//   - drive roots ("C:/", "C:\", "D:") on Windows
//   - the POSIX root ("/")
//   - UNC share roots ("\\server\share" with no subpath)
//   - the user's home directory itself (subdirs of home are still allowed)
//   - paths containing ".." traversal segments after normalization
function validateFileAccessPath(raw: string, ctx: z.RefinementCtx, idx: number): void {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: "fileAccessPaths entry must be a non-empty string",
    });
    return;
  }
  if (!isAbsolute(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must be absolute (got "${raw}")`,
    });
    return;
  }
  // Look for ".." in the *raw* path. node:path.normalize collapses traversal
  // into the resulting target (e.g. "/home/user/../etc" → "/home/etc") so a
  // post-normalize check would silently accept the collapsed form. We block
  // any input that contains a literal ".." segment.
  if (raw.split(/[\\/]/).includes("..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must not contain ".." segments (got "${raw}")`,
    });
    return;
  }
  const normalized = normalize(raw);
  // Filesystem root, OS-agnostic. On Windows, normalize("/") returns "\".
  if (normalized === "/" || normalized === "\\") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must not be the filesystem root (got "${raw}")`,
    });
    return;
  }
  // Windows drive roots: "C:", "C:\", "C:/" (with or without trailing slash)
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must not be a Windows drive root (got "${raw}"). Use a project subfolder instead.`,
    });
    return;
  }
  // UNC share root with no further path: \\server\share or \\server\share\
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(normalized)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must not be a bare UNC share root (got "${raw}"). Use a subfolder inside the share.`,
    });
    return;
  }
  // Home dir itself (subdirs of home are still allowed). Compare resolved forms
  // because homedir() on Windows is a backslash path while configs may use "/".
  const home = homedir();
  if (home && resolvePath(normalized) === resolvePath(home)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [idx],
      message: `fileAccessPaths entry must not be the user's home directory itself (got "${raw}"). Use a subfolder of home.`,
    });
    return;
  }
  void sep;
}

// --- Gateway ---

export const gatewayConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3000),
  tls: z
    .object({
      cert: z.string(),
      key: z.string(),
    })
    .optional(),
  auth: z
    .object({
      mode: z.enum(["token", "password", "none"]).default("token"),
      token: z.string().min(32, "Auth token must be at least 32 characters").optional(),
      password: z.string().min(12, "Password must be at least 12 characters").optional(),
    })
    .refine(
      (auth) =>
        auth.mode === "none" ||
        (auth.mode === "token" && typeof auth.token === "string" && auth.token.length >= 32) ||
        (auth.mode === "password" && typeof auth.password === "string" && auth.password.length >= 12),
      { message: "Auth mode 'token' requires auth.token (min 32 chars); mode 'password' requires auth.password (min 12 chars)" },
    ),
  origins: z.array(z.string()).default(["http://localhost:*"]),
  /**
   * When true, parse `X-Forwarded-For` to derive the client IP for the
   * pre-upgrade WebSocket rate limiter. Required behind a real reverse
   * proxy — without it, the limiter sees only the proxy's IP and
   * collapses to a single bucket shared across all real clients.
   * Leave false for the documented localhost-only deployment.
   * RT-2026-04-30-008.
   */
  trustProxy: z.boolean().default(false),
});

// --- Tool definitions ---

export const toolParameterSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().optional(),
  required: z.boolean().default(true),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  default: z.unknown().optional(),
  secretRef: z.boolean().default(false),
});

/**
 * Declared shape of a single field in a tool's structured output.
 * Runtime metadata only — never sent to the LLM. Used by the Phase 2
 * DAG validator for type-checking step-to-step data flow and by the
 * executor for (tool, input_hash) → output memoization.
 */
export const toolOutputSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().optional(),
  required: z.boolean().default(true),
});

export const toolDefinitionConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().max(500),
  parameters: z.record(z.string(), toolParameterSchema).default({}),
  outputs: z.record(z.string(), toolOutputSchema).default({}),
  effectClass: z
    .enum(["read", "write", "network", "exec", "privileged"])
    .default("privileged"),
});

// --- Agent ---

export const agentConfigSchema = z.object({
  id: z.string().default("default"),
  name: z.string().default("CrabMeat Agent"),
  systemPrompt: z.string().max(50_000, "System prompt must not exceed 50,000 characters").default("You are a helpful AI assistant."),
  temperature: z.number().min(0).max(2).default(0.7),
  // 1M cap guards against typo configs (`40960000`) and runaway bills.
  // No current model accepts more than a few hundred thousand output
  // tokens; a hard ceiling here prevents the provider from rejecting
  // a request at runtime with a confusing 400 and keeps resource
  // planning predictable. Raise if a future model exceeds this.
  maxTokens: z.number().int().positive().max(1_000_000).default(4096),
  /**
   * Explicit context window size in tokens. If omitted, falls back to
   * maxTokens * 4 as a rough heuristic. Set this to match your model's
   * actual context window for accurate compaction and truncation.
   */
  contextWindowTokens: z.number().int().positive().max(10_000_000).optional(),
  /**
   * Characters-per-token ratio for token estimation. Default: 3.5.
   * Code-heavy workloads may benefit from ~3.0; English prose from ~4.0.
   */
  charsPerToken: z.number().positive().default(3.5),
  tools: z.array(z.string()).default([]),
  allowedEffects: z
    .array(z.enum(["read", "write", "network", "exec", "privileged"]))
    .default(["read"]),
  maxToolIterations: z.number().int().min(1).max(20).default(5),
  /**
   * When true, fail fast if instruction files (CLAW.md) or agent identity
   * (AGENT.json / .shard) cannot be loaded. Default: false (graceful fallback).
   */
  strictInstructions: z.boolean().default(false),
  toolRateLimit: z
    .object({
      maxCalls: z.number().int().positive().default(20),
      windowMs: z.number().int().positive().default(60_000),
      lockoutMs: z.number().int().positive().default(30_000),
    })
    .default({}),
  /**
   * Reorder the providers[] cascade chain at runtime. "config-order"
   * leaves the array as written. "api-first" pulls non-loopback (API)
   * providers ahead of localhost ones. "local-first" inverts that.
   * Cooldowns key on provider id, so the reorder is purely advisory —
   * it doesn't reset failover state. Uncensored-tagged providers are
   * always excluded from the cascade chain regardless of priority,
   * since they're only reached through refusal-reroute.
   */
  providerPriority: z
    .enum(["config-order", "api-first", "local-first"])
    .default("config-order"),
});

// --- Provider ---

/**
 * Block SSRF targets: link-local, cloud metadata, and private RFC1918 ranges.
 * When allowLocal is true, localhost/127.0.0.1 are permitted (for Ollama, etc.).
 */
export function isSafeBaseUrl(url: string, allowLocal = false): boolean {
  try {
    const parsed = new URL(url);
    // Only allow https (and http for explicit localhost dev)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();

    // Empty host → no target → reject. Catches `http://` / `https:///path`.
    if (!host) return false;

    // Block cloud metadata endpoints — always
    if (host === "169.254.169.254" || host === "metadata.google.internal") return false;
    // Block link-local IPv4 — always
    if (host.startsWith("169.254.")) return false;
    // Block private IPv4 ranges — always (these are not localhost)
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    // Block 0.0.0.0 — always (wildcard bind, not a real target)
    if (host === "0.0.0.0") return false;

    // IPv6 — URL.hostname wraps the address in brackets. Strip them
    // and run range checks. Coverage: loopback, link-local fe80::/10,
    // ULA fd00::/8 + fc00::/7, IPv4-mapped (::ffff:n.n.n.n) which would
    // otherwise smuggle a private IPv4 through the IPv6 path.
    if (host.startsWith("[") && host.endsWith("]")) {
      const ip6 = host.slice(1, -1).toLowerCase();
      // Loopback ::1 (also matches the fully-expanded 0:0:0:0:0:0:0:1)
      if (ip6 === "::1" || /^0(:0){0,6}:1$/.test(ip6)) {
        return allowLocal;
      }
      // Link-local fe80::/10 — only fe80–febf are in /10, but Node's
      // hostname normalizer lowercases and won't expand, so a prefix
      // check on `fe8`/`fe9`/`fea`/`feb` covers it conservatively.
      if (/^fe[89ab][0-9a-f]?:/i.test(ip6)) return false;
      // Unique-local fc00::/7 (RFC 4193) — covers fc00–fdff. The /7
      // is fc..fd, and Node leaves the textual address as-is so a
      // prefix check on the first hex group handles every variation.
      if (/^f[cd][0-9a-f]{0,2}:/i.test(ip6)) return false;
      // IPv4-mapped IPv6: ::ffff:a.b.c.d (text form) or ::ffff:0:hex
      // (numeric form). Extract the embedded IPv4 and rerun the
      // IPv4 range checks against it.
      const v4MappedText = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip6);
      if (v4MappedText) {
        const v4 = v4MappedText[1]!;
        if (
          v4 === "127.0.0.1" || v4.startsWith("127.") ||
          v4 === "0.0.0.0" ||
          v4.startsWith("10.") ||
          v4.startsWith("192.168.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
          v4.startsWith("169.254.")
        ) {
          return false;
        }
      }
      const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip6);
      if (v4MappedHex) {
        const hi = parseInt(v4MappedHex[1]!, 16);
        const lo = parseInt(v4MappedHex[2]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const a = (hi >> 8) & 0xff, b = hi & 0xff;
          const c = (lo >> 8) & 0xff, d = lo & 0xff;
          // Reject if the embedded IPv4 falls in any private/loopback range.
          if (
            a === 127 ||
            (a === 0 && b === 0 && c === 0 && d === 0) ||
            a === 10 ||
            (a === 192 && b === 168) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 169 && b === 254)
          ) {
            return false;
          }
        }
      }
    }

    // Localhost variants — allow when flag is set (for Ollama, local LLMs)
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return allowLocal;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Provider config. Note: baseUrl validation is applied at root config level
 * via superRefine so it can access the `allowLocalProviders` flag.
 */
export const providerConfigSchema = z.object({
  id: z.string(),
  type: z.enum(["openai", "anthropic", "ollama"]),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  maxRetries: z.number().int().min(0).default(2),
  timeoutMs: z.number().int().positive().default(60_000),
  /**
   * Reasoning / thinking budget control. Maps to the OpenAI-compat
   * `reasoning_effort` field. Forwarded to providers that recognize it
   * (Gemini 2.5+ via Google's OpenAI-compat layer; future thinking-
   * capable models on other providers). Providers that don't recognize
   * the param ignore it.
   *
   * Default behavior (when undefined): provider's own default. For
   * Gemini 2.5 models that's "auto", which can burn the entire output-
   * token budget on internal reasoning and return zero final-channel
   * content. Set to "none" for a vanilla chat completion that doesn't
   * spend tokens thinking.
   */
  reasoningEffort: z
    .enum(["none", "low", "medium", "high"])
    .optional(),
  /**
   * Provider-specific options. Primary use case: passing Ollama options
   * like `num_ctx`, `num_predict`, `repeat_penalty` per provider entry
   * under a nested `options` object — Ollama defaults gpt-oss to
   * num_ctx=4096 on a 16GB card via its VRAM-budgeting heuristic, which
   * silently truncates an 8k+ token system prompt.
   *
   * IMPORTANT: providerOptions.options.num_ctx is only honored by the
   * "ollama" provider type, which posts to Ollama's native /api/chat
   * endpoint. The "openai" provider type sends to Ollama's OpenAI-compat
   * /v1 endpoint, which silently drops the `options` object — num_ctx
   * set there is inert. Use type "ollama" for a local Ollama.
   *
   * Shape is provider-defined; we don't validate keys.
   */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional semantic role used by the failover cascade. "primary" and
   * "backup" sit in the cascade chain (transport-error fallback walks
   * them in order). "uncensored" is reached only by the refusal-reroute
   * path — never by transport-error cascade — and is the target the
   * single-hop refusal lookup prefers when present. Pure metadata when
   * unset; the chain order in the providers[] array is still the
   * source of truth.
   */
  role: z.enum(["primary", "backup", "uncensored"]).optional(),
});

// --- Session ---

export const sessionConfigSchema = z.object({
  backend: z.enum(["json", "sqlite"]).default("json"),
  dir: z.string().default(".crabmeat/sessions").refine(
    (dir) => {
      const normalized = normalize(dir);
      // Block absolute paths (drive letter, root slash, UNC).
      if (isAbsolute(normalized)) return false;
      // Block any segment equal to "..". Checking segments rather than
      // a substring match avoids false positives on legitimate filenames
      // that merely contain two dots (e.g. "..hidden" or "v1.2..").
      const segments = normalized.split(/[\\/]/);
      if (segments.includes("..")) return false;
      return true;
    },
    { message: "Session directory must be a relative path without traversal (../)" },
  ),
  maxTranscriptEntries: z.number().int().positive().default(200),
  retentionDays: z.number().int().positive().default(30),
});

// --- Routing ---

export const routeBindingSchema = z.object({
  channel: z.string().optional(),
  peer: z.string().optional(),
  agentId: z.string(),
});

export const routingConfigSchema = z.object({
  defaultAgentId: z.string().default("default"),
  bindings: z.array(routeBindingSchema).default([]),
});

// --- Root config ---

// --- Audit ---

export const auditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxEntries: z.number().int().positive().default(10_000),
  /** Directory for audit log persistence. Entries are appended as JSONL with signed snapshots. */
  persistDir: z.string().default(".crabmeat/audit"),
  /** Number of entries to buffer before flushing to disk. Default: 10. */
  flushThreshold: z.number().int().positive().default(10),
}).default({});

// --- Admin ---

export const adminConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().min(32, "Admin token must be at least 32 characters").optional(),
  /**
   * Public base URL the kill-link endpoint is reachable at. Used by
   * message_send to construct the single-use kill URL embedded in
   * every outbound external message. When unset, kill URLs are not
   * included in delivered messages — acceptable for CLI-only tests,
   * required once any external (Discord/Telegram/…) connector ships.
   * Must be a safe public URL (HTTPS in production).
   */
  publicBaseUrl: z.string().url().optional(),
}).refine(
  (admin) => !admin.enabled || (typeof admin.token === "string" && admin.token.length >= 32),
  { message: "Admin endpoints require admin.token (min 32 chars) when enabled" },
).default({});

// --- Layer 2 ---

export const layer2ConfigSchema = z.object({
  /** Master switch. When false, Layer 2 is skipped entirely. Default: false. */
  enabled: z.boolean().default(false),
  /**
   * ID of the provider in the providers[] array to use for Layer 2.
   * Must reference an existing provider when enabled (validated at root level).
   * Typically an Ollama instance via the "ollama" provider type.
   */
  providerId: z.string().default(""),
  /** Minimum Layer 0 confidence for Layer 2 to intercept. Below this → Layer 3. */
  confidenceThreshold: z.number().min(0).max(1).default(0.5),
  /** Maximum Layer 0 confidence for Layer 2 to intercept. Above this → Layer 0 handles. */
  confidenceCeiling: z.number().min(0).max(1).default(0.69),
  /** Max tokens for Layer 2 responses (keep small — disambiguations, not essays). */
  maxTokens: z.number().int().positive().max(10_000).default(256),
  /** Temperature for local model (low = deterministic disambiguation). */
  temperature: z.number().min(0).max(2).default(0.3),
  /**
   * Phrases in the local model's response that signal it can't handle the request.
   * Triggers escalation to Layer 3.
   */
  escalationMarkers: z.array(z.string()).default([
    "I'm not sure",
    "I don't know",
    "I cannot determine",
    "you should ask",
    "beyond my capability",
    "I need more context",
    "this is complex",
    "I'm unable to",
  ]),
  /** Health check timeout in ms. If local model doesn't respond in time, skip Layer 2. */
  healthCheckTimeoutMs: z.number().int().positive().default(2000),
  /** Show [L2] badge on Layer 2 responses. Default: false. */
  showLayerBadge: z.boolean().default(false),
  /** System prompt for the local disambiguation model. */
  systemPrompt: z.string().max(5000).default(
    "You are a disambiguation assistant. Your job is to clarify ambiguous user requests. " +
    "Ask a single, specific clarifying question if the intent is unclear. " +
    "If you can confidently answer a simple question, do so briefly in 1-2 sentences. " +
    "If the request requires deep reasoning, complex analysis, or code generation, " +
    "respond with exactly: \"I need more context\" so it can be escalated to a more capable model.",
  ),
}).default({});

// --- Skills ---

export const skillsConfigSchema = z.object({
  /** Enable the skills system. Default: false. */
  enabled: z.boolean().default(false),
  /** Skills directory relative to workspace root. */
  dir: z.string().default(".crabmeat/skills"),
  /** Max characters per individual SKILL.md file. */
  maxSkillSizeChars: z.number().int().positive().default(8_000),
  /** Max total characters for all skills combined in the prompt. */
  maxTotalChars: z.number().int().positive().default(32_000),
}).default({});

// --- cortexDream (brain-maintenance / tiered memory consolidation) ---

/**
 * cortexDream config — drives the periodic brain-maintenance pass:
 * memdir consolidation, reflection on recent engrams, and (later)
 * STM → LTM → core promotion across the shard mindshard system.
 * Disabled by default; the v0 consolidator is a stub that rebuilds
 * MEMORY.md deterministically. Tier promotion scaffolding lives in
 * memory/cortex-tiers.ts — portable code not yet wired into the
 * run path.
 */
export const cortexDreamConfigSchema = z.object({
  enabled: z.boolean().default(false),
  memoryDir: z.string().default(".crabmeat/memory"),
  sessionsDir: z.string().default(".crabmeat/sessions"),
  minHoursBetweenRuns: z.number().positive().default(24),
  minSessionsBetweenRuns: z.number().int().positive().default(5),
  throttleMs: z.number().int().positive().default(10 * 60 * 1000),
  lockStaleMs: z.number().int().positive().default(60 * 60 * 1000),
}).default({});

// --- Connectors (outbound messaging) ---

/**
 * Email IMAP/SMTP inbound+outbound connector. Designed for a dedicated
 * Gmail account using an App Password (not the user's regular password
 * or a passkey — Gmail blocks plain-password IMAP). Put the credentials
 * in .crabmeat/local.json (gitignored).
 *
 * The allowFromAddresses whitelist is the security boundary: any message
 * from an address not on the list is dropped before reaching the agent.
 * That keeps a public-ish Gmail address from becoming an open prompt
 * injection vector.
 */
export const emailImapConnectorConfigSchema = z.object({
  /** IMAP server host. Default: imap.gmail.com. */
  imapHost: z.string().min(1).default("imap.gmail.com"),
  /** IMAP port. Default: 993 (TLS). */
  imapPort: z.number().int().positive().max(65_535).default(993),
  /** SMTP server host. Default: smtp.gmail.com. */
  smtpHost: z.string().min(1).default("smtp.gmail.com"),
  /** SMTP port. Default: 587 (STARTTLS). */
  smtpPort: z.number().int().positive().max(65_535).default(587),
  /** Mailbox username (full email address for Gmail). */
  user: z.string().email(),
  /** App Password (16 chars from Google account → App Passwords page). */
  password: z.string().min(1),
  /** From-address used on outgoing replies. Defaults to user. */
  from: z.string().email().optional(),
  /**
   * Whitelist of sender addresses the agent will respond to. Any message
   * from an address not on this list is silently dropped (marked Seen so
   * we don't reprocess it). At least one address is required — there is
   * no "open to anyone" mode by design.
   */
  allowFromAddresses: z.array(z.string().email()).min(1),
  /**
   * Recipients used when the agent proactively sends through message_send
   * with this connector id. Defaults to allowFromAddresses, which is usually
   * the owner account for a single-operator setup.
   */
  outboundTo: z.array(z.string().email()).optional(),
  /** How often to poll INBOX, in ms. Default: 30 000. */
  pollIntervalMs: z.number().int().positive().min(5_000).max(600_000).default(30_000),
  /** Mailbox to watch. Default: INBOX. */
  mailbox: z.string().min(1).default("INBOX"),
  /** Stable id used in logs and the inbound registry. */
  id: z.string().min(1).default("email-imap"),
  /**
   * Per-file size cap for outbound attachments staged via email_attach /
   * email_attach_content. Default: 5 MB (Gmail-friendly). Hard upper bound:
   * 25 MB (Gmail's outright SMTP attachment ceiling). Operators on bandwidth-
   * tight connections or with stricter SMTP servers should lower this.
   */
  attachmentMaxBytesPerFile: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  /**
   * Cumulative cap across every attachment queued for a single reply. Default:
   * 20 MB. Hard upper bound: 50 MB. Must be >= attachmentMaxBytesPerFile (a
   * per-file ceiling above the cumulative cap is incoherent).
   */
  attachmentMaxBytesTotal: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  /**
   * When true (default, Phase 4.5), the connector skips inbounds where the
   * agent is only on Cc and the subject/body does not address the agent by
   * name (full email address, "@local-part" mention, or local-part as a
   * standalone word). This prevents the agent from auto-replying to every
   * thread it gets CC'd on. Set to false to fall back to legacy behavior:
   * reply to every allowlisted inbound regardless of recipient role.
   *
   * Operators on a generic local-part ("info@", "contact@") may want false
   * because the standalone-word match will false-fire frequently.
   */
  replyOnlyWhenAddressed: z.boolean().default(true),
}).superRefine((cfg, ctx) => {
  if (cfg.attachmentMaxBytesTotal < cfg.attachmentMaxBytesPerFile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachmentMaxBytesTotal"],
      message: `attachmentMaxBytesTotal (${cfg.attachmentMaxBytesTotal}) must be >= attachmentMaxBytesPerFile (${cfg.attachmentMaxBytesPerFile})`,
    });
  }
});

export const connectorsConfigSchema = z.object({
  /** When true, register a dev-only echo connector (logs-only, no external delivery). */
  echo: z.boolean().default(false),
  /** Email IMAP/SMTP connector. Put creds in .crabmeat/local.json (gitignored). */
  emailImap: emailImapConnectorConfigSchema.optional(),
}).default({});

// --- Webhooks ---

export const webhookConfigSchema = z.object({
  /** Enable webhook triggers for scheduled tasks. Default: false. */
  enabled: z.boolean().default(false),
  /** Base path prefix for webhook URLs. Default: "/hook". */
  basePath: z.string().default("/hook"),
  /** Require a secret for webhook authentication. Default: true. */
  requireSecret: z.boolean().default(true),
}).default({});

// --- Refusal interception ---

/**
 * Configures the interception layer that catches primary-model refusals
 * and transparently reroutes the request to a local fallback. Only
 * requests whose content class is on the allowlist will reroute — this
 * is the explicit gate that keeps the "treat user as an adult" pattern
 * from silently reaching into genuinely off-limits territory.
 *
 * See src/agents/refusal-detect.ts and src/agents/content-class.ts.
 */
export const refusalFallbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Ordered list of provider ids to reroute to on refusal. The first
   * available provider in this list wins. Must reference providers
   * that exist in the top-level `providers[]` array.
   */
  fallbackProviderIds: z.array(z.string()).default([]),
  /**
   * Allowed content classes. Requests that the classifier (or the
   * user's explicit tag) maps to one of these classes will reroute on
   * refusal; anything else stays refused. Start conservative — add
   * classes here only when you've decided you want this request shape
   * to route to a local model.
   */
  contentClassAllowlist: z.array(z.string()).default([]),
  /**
   * Bytes of stream lead to buffer before deciding whether to pass
   * through or reroute. Larger values catch more refusal shapes but
   * delay visible output; 200 is enough for all tested refusal prefixes.
   */
  leadBytes: z.number().int().min(50).max(2000).default(200),
  /**
   * When true, also arm the interception layer on requests whose
   * content class the heuristic couldn't identify. This matches the
   * "no babysitter" posture — any refusal on a benign-looking query
   * (the classic case: small local models refusing normal questions
   * out of over-caution) gets rerouted. Default false preserves the
   * strict allowlist-only semantics. Trade-off: when true, every
   * turn pays the leadBytes streaming delay.
   */
  rerouteUnclassified: z.boolean().default(false),
}).default({});

// --- Root ---

/**
 * Known top-level config keys. Used by the strict-rejection check in
 * configSchema's superRefine: any top-level key NOT in this set (and
 * not `_`-prefixed for inline-comment use) is rejected. Add new keys
 * here in lockstep with adding them to configSchema below.
 */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "gateway",
  "agents",
  "providers",
  "session",
  "routing",
  "tools",
  "audit",
  "admin",
  "layer2",
  "skills",
  "webhooks",
  "connectors",
  "hooks",
  "cortexDream",
  "refusalFallback",
  "allowLocalProviders",
  "fileAccessPaths",
  "fileAccessPresets",
  "modelPresets",
]);

export const configSchema = z.object({
  gateway: gatewayConfigSchema,
  agents: z.array(agentConfigSchema).min(1).default([agentConfigSchema.parse({})]),
  providers: z.array(providerConfigSchema).min(1),
  session: sessionConfigSchema.default({}),
  routing: routingConfigSchema.default({}),
  tools: z.array(toolDefinitionConfigSchema).default([]),
  audit: auditConfigSchema,
  admin: adminConfigSchema,
  layer2: layer2ConfigSchema,
  skills: skillsConfigSchema,
  webhooks: webhookConfigSchema,
  connectors: connectorsConfigSchema,
  hooks: hooksConfigSchema,
  cortexDream: cortexDreamConfigSchema,
  refusalFallback: refusalFallbackConfigSchema,
  allowLocalProviders: z.boolean().default(false),
  /**
   * Additional absolute paths the file tools (file_read/file_write) may access
   * outside the workspace root. Must be explicit absolute paths — no globs.
   * Drive roots, the POSIX root, bare UNC shares, the user's home dir itself,
   * and traversal segments are rejected so a tired-operator config cannot turn
   * file_read/file_write into host-wide tools (RT-2026-05-01-006).
   * Example: ["C:/Users/me/Downloads", "C:/Users/me/Documents/notes"]
   */
  fileAccessPaths: z
    .array(z.string())
    .default([])
    .superRefine((paths, ctx) => {
      paths.forEach((p, i) => validateFileAccessPath(p, ctx, i));
    }),
  /**
   * Convenience access roots for common user folders. These expand to absolute
   * subfolders under the current user's home directory at runtime. They are
   * opt-in and deliberately do not include the home directory itself.
   */
  fileAccessPresets: z
    .array(z.enum(FILE_ACCESS_PRESETS))
    .default([]),
  /**
   * Stable numeric model presets for `/model <number>` and `/model swap <number>`.
   * Slots 1–9 map to a model name. When set, presets take precedence over the
   * dynamic Ollama-index lookup, so `/model 1` always means *your* favorite #1
   * regardless of how Ollama orders its tag list today.
   * Example: { "1": "hermes3:latest", "2": "gpt-oss:20b", "3": "deepseek-r1:14b" }
   */
  modelPresets: z.record(z.string().regex(/^[1-9]$/), z.string().min(1)).default({}),
}).passthrough().superRefine((cfg, ctx) => {
  // Reject any unknown top-level key. `_`-prefixed keys are tolerated
  // as inline comments — JSON has no native comment syntax and
  // crabmeat.example.json uses `_comment` / `_emailImap_note` etc. to
  // document config blocks where operators read them. This keeps the
  // strict-rejection footgun guard (typos, dead config blocks) without
  // costing the inline-doc UX.
  for (const key of Object.keys(cfg)) {
    if (key.startsWith("_")) continue;
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Unknown top-level config key '${key}'. Known keys: ${[...KNOWN_TOP_LEVEL_KEYS].sort().join(", ")}. (\`_\`-prefixed keys are tolerated as JSON comments.)`,
      });
    }
  }
  // Validate provider baseUrls with awareness of allowLocalProviders flag
  for (let i = 0; i < cfg.providers.length; i++) {
    const p = cfg.providers[i]!;
    if (p.baseUrl && !isSafeBaseUrl(p.baseUrl, cfg.allowLocalProviders)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providers", i, "baseUrl"],
        message: cfg.allowLocalProviders
          ? "baseUrl must be a safe URL (no private/link-local/metadata addresses)"
          : "baseUrl must be a safe HTTPS URL (no private/link-local/metadata/localhost addresses). Set allowLocalProviders: true for local models.",
      });
    }
  }

  // Validate Layer 2 provider reference
  if (cfg.layer2.enabled && cfg.layer2.providerId) {
    const providerExists = cfg.providers.some((p) => p.id === cfg.layer2.providerId);
    if (!providerExists) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layer2", "providerId"],
        message: `Layer 2 provider "${cfg.layer2.providerId}" does not match any provider ID in providers[]. Available: ${cfg.providers.map((p) => p.id).join(", ") || "(none)"}`,
      });
    }
  }

  // Validate refusalFallback provider references
  if (cfg.refusalFallback.enabled) {
    if (cfg.refusalFallback.fallbackProviderIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refusalFallback", "fallbackProviderIds"],
        message: "refusalFallback.enabled is true but no fallbackProviderIds are configured",
      });
    }
    for (let i = 0; i < cfg.refusalFallback.fallbackProviderIds.length; i++) {
      const id = cfg.refusalFallback.fallbackProviderIds[i]!;
      if (!cfg.providers.some((p) => p.id === id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refusalFallback", "fallbackProviderIds", i],
          message: `Fallback provider "${id}" does not match any provider ID in providers[]. Available: ${cfg.providers.map((p) => p.id).join(", ") || "(none)"}`,
        });
      }
    }
  }
});

export type Config = z.infer<typeof configSchema>;
export type AdminConfig = z.infer<typeof adminConfigSchema>;
export type AuditConfig = z.infer<typeof auditConfigSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export type ToolDefinitionConfig = z.infer<typeof toolDefinitionConfigSchema>;
export type ToolParameterConfig = z.infer<typeof toolParameterSchema>;
export type ToolOutputConfig = z.infer<typeof toolOutputSchema>;
export type Layer2Config = z.infer<typeof layer2ConfigSchema>;
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;
export type CortexDreamConfig = z.infer<typeof cortexDreamConfigSchema>;
export type RefusalFallbackConfig = z.infer<typeof refusalFallbackConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type ConnectorsConfig = z.infer<typeof connectorsConfigSchema>;
export type EmailImapConnectorConfig = z.infer<typeof emailImapConnectorConfigSchema>;
export type { HooksConfig } from "../hooks/config.js";
