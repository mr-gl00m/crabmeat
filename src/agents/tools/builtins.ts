/**
 * Built-in tool handlers for CrabMeat agentic execution.
 *
 * Each handler receives validated parameters and returns
 * { content, isError? }. Security boundaries:
 *
 * - File tools: jailed to workspace root, path traversal blocked
 * - Shell tool: cwd scoped to configured roots, command denylist, output capped
 * - Web fetch: SSRF protection via isSafeBaseUrl, size capped
 *
 * All tool output is auto-scanned for secrets by the execution
 * engine (invoke.ts) before entering the context window.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, stat, lstat, realpath, mkdir, rename, copyFile, unlink, rmdir } from "node:fs/promises";
import { resolve, relative, sep, normalize, join, dirname, basename } from "node:path";
import { platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { registerAgentDataTools } from "./agent-data.js";
import { registerSchedulerTools } from "./scheduler.js";
import { registerTodoTools } from "./todo.js";
import { registerMessageSendTool, setKillUrlBase } from "./message-send.js";
import { registerWebSearchTool } from "./web-search.js";
import { registerSubagentSpawnTool } from "./subagent-spawn.js";
import { registerPlanModeTool } from "./plan-mode.js";
import { registerEmailAttachTool } from "./email-attach.js";
import { registerPdfExtractTool } from "./pdf-extract.js";
import {
  askQuestion as askUserQuestion,
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
  MIN_ASK_TIMEOUT_MS,
} from "./ask-user-broker.js";
import { isSafeBaseUrl } from "../../config/schema.js";
import { writeFileAtomic } from "../../infra/fs.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { diagnostics } from "../../infra/diagnostics/index.js";

/**
 * Shared return shape for all built-in handlers.
 * `outputs` is a structured record consumed by the runtime (audit logs,
 * Phase 2 DAG step memoization) — it never reaches the LLM context.
 */
type BuiltinResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

// ── Workspace jail ────────────────────────────────────────

let workspaceRoot = process.cwd();
let extraAllowedPaths: string[] = [];

// ── Sensitive-filename blocklist ──────────────────────────
//
// Hard-reject paths whose basename matches a known credential-bearing
// shape, or whose ancestor segments include a credential-bearing
// directory. Runs after the workspace jail accepts a path — the jail
// keeps the LLM inside the project, this blocklist keeps it away from
// the project's secrets. Closes the Gil-Pinsky-style exfil chain
// where an attacker-controlled message asks the agent to attach .env
// to its reply.
//
// Read AND write tools both hit this list. We do not want the agent
// reading credentials (so it can't echo them out), and we do not want
// the agent writing them (so it cannot tamper with the operator's
// env). The operator can still edit these files manually.
const SENSITIVE_FILENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(rc|\..+)?$/i,                     // .env, .envrc, .env.local, .env.production
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,  // SSH key pairs (pub included — known-host correlation)
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,                                 // PKCS#12 cert bundle (private key inside)
  /\.pfx$/i,                                 // PKCS#12 (Windows naming)
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^\.htpasswd$/i,
  /^\.dockercfg$/i,
  /^credentials$/i,                          // .aws/credentials, gcloud
];

const SENSITIVE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".aws",
  ".ssh",
  ".gnupg",
]);

function isSensitivePath(resolved: string): boolean {
  const base = basename(resolved);
  if (SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(base))) return true;
  const segments = resolved.split(sep);
  for (const seg of segments) {
    if (SENSITIVE_DIRECTORY_NAMES.has(seg)) return true;
  }
  return false;
}

/** Stable error message so callers can format consistently and tests can match. */
function sensitivePathDenialMessage(userPath: string): string {
  return (
    `Access denied: '${userPath}' matches a sensitive-filename pattern ` +
    `(e.g. .env, id_rsa, *.pem, .aws/credentials). The LLM tool surface ` +
    `is blocked from credential files to prevent accidental exfiltration. ` +
    `Edit the file directly if you need to change it.`
  );
}

/** Override the workspace root (for testing or config). */
export function setWorkspaceRoot(root: string): void {
  workspaceRoot = resolve(root);
}

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

/**
 * Set additional absolute paths the file tools may access outside the workspace.
 * Must be called before any tool invocations.
 */
export function setFileAccessPaths(paths: string[]): void {
  extraAllowedPaths = paths.map((p) => resolve(normalize(p)));
}

export function getFileAccessPaths(): string[] {
  return [...extraAllowedPaths];
}

function formatAllowedRootsForPrompt(): string {
  const lines = [
    `- Workspace: ${workspaceRoot} (relative paths like 'notes.txt' or 'output/report.md')`,
  ];
  for (const p of extraAllowedPaths) {
    lines.push(`- Extra root: ${p} (use absolute paths for clarity)`);
  }
  return lines.join("\n");
}

// ── Dry-run state ─────────────────────────────────────────
//
// Bulk destructive ops over this threshold must be previewed (or carry a
// matching confirm_token from a prior preview) before they execute. Motivated
// by the "3000-file-rename rule": the agent should never be able to wipe a
// mountain of data in a single tool call without the user or at least a prior
// reflection pass seeing the plan first.

let dryRunBulkThreshold = 25;

/** Override the bulk destructive threshold (tests, config). */
export function setDryRunBulkThreshold(n: number): void {
  dryRunBulkThreshold = Math.max(1, n | 0);
}

export function getDryRunBulkThreshold(): number {
  return dryRunBulkThreshold;
}

/**
 * Preview tokens minted by dry_run or threshold auto-preview calls. The value
 * is the fingerprint of the planned operation (tool id + sorted source/dest
 * list); execute calls must carry a confirm_token whose fingerprint matches
 * the current invocation, preventing a preview of plan A from authorizing
 * execution of plan B.
 *
 * Single-process in-memory store is sufficient: preview and execute happen
 * in the same CrabMeat run, adjacent turns of the same session.
 */
const pendingPreviews = new Map<string, { fingerprint: string; createdAt: number }>();
const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_PREVIEWS = 200;

function reapExpiredPreviews(): void {
  const now = Date.now();
  for (const [token, entry] of pendingPreviews) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      pendingPreviews.delete(token);
    }
  }
  if (pendingPreviews.size > MAX_PENDING_PREVIEWS) {
    // LRU evict oldest by insertion order
    const excess = pendingPreviews.size - MAX_PENDING_PREVIEWS;
    let i = 0;
    for (const key of pendingPreviews.keys()) {
      if (i++ >= excess) break;
      pendingPreviews.delete(key);
    }
  }
}

function mintConfirmToken(fingerprint: string): string {
  reapExpiredPreviews();
  const token = "cft_" + randomUUID().replace(/-/g, "");
  pendingPreviews.set(token, { fingerprint, createdAt: Date.now() });
  return token;
}

function consumeConfirmToken(token: string, fingerprint: string): boolean {
  reapExpiredPreviews();
  const entry = pendingPreviews.get(token);
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint) return false;
  pendingPreviews.delete(token);
  return true;
}

/** Stable fingerprint for a bulk (src, dst) plan — order-insensitive. */
function planFingerprint(
  toolId: string,
  pairs: ReadonlyArray<{ src: string; dst: string }>,
): string {
  const sorted = [...pairs]
    .map((p) => `${p.src}\0${p.dst}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(toolId + "\0" + sorted).digest("hex");
}

/** Clear pending previews (for tests). */
export function clearPendingPreviews(): void {
  pendingPreviews.clear();
}

/**
 * Resolve a user-supplied path within the workspace jail.
 * Also accepts paths that fall under any explicitly allowed extra paths.
 * Returns null if the path escapes all allowed roots.
 */
function jailPath(userPath: string): string | null {
  // Reject obviously truncated paths (LLM sometimes cuts off mid-string)
  if (userPath.endsWith("...") || userPath.endsWith("…")) {
    return null;
  }

  const normalizedInput = normalize(userPath);

  // If the input looks absolute, check it against all allowed roots directly
  const isAbsolute = /^([A-Za-z]:[/\\]|\/)/u.test(normalizedInput);
  if (isAbsolute) {
    const resolved = resolve(normalizedInput);
    if (resolved.startsWith(workspaceRoot + sep) || resolved === workspaceRoot) {
      return isSensitivePath(resolved) ? null : resolved;
    }
    for (const allowed of extraAllowedPaths) {
      if (resolved.startsWith(allowed + sep) || resolved === allowed) {
        return isSensitivePath(resolved) ? null : resolved;
      }
    }
    return null; // Absolute path not in any allowed root
  }

  // Relative path — resolve against workspace root first
  const cleaned = normalizedInput.replace(/^[/\\]+/, "");
  const wsResolved = resolve(workspaceRoot, cleaned);

  if (wsResolved.startsWith(workspaceRoot + sep) || wsResolved === workspaceRoot) {
    return isSensitivePath(wsResolved) ? null : wsResolved;
  }

  // Also try resolving against each extra allowed path.
  // This lets the LLM use paths like "videos/file.mp4" when the
  // workspace root is the project dir but the target is in Downloads.
  for (const allowed of extraAllowedPaths) {
    const extraResolved = resolve(allowed, cleaned);
    if (extraResolved.startsWith(allowed + sep) || extraResolved === allowed) {
      return isSensitivePath(extraResolved) ? null : extraResolved;
    }
  }

  return null;
}

/**
 * Build the right denial message for a jail rejection. Distinguishes
 * sensitive-file blocks from generic outside-the-workspace rejections
 * so the LLM sees a clear "do not retry" signal on credential files
 * (rather than thinking it mistyped the path and looping).
 */
export function jailDenialMessage(userPath: string): string {
  // Sensitive check is shape-based; we can re-derive it from the input
  // without needing the (already-discarded) jail resolution. Cover both
  // the raw input form and the workspace-resolved form so an absolute
  // path or a relative path both classify the same way.
  const normalizedInput = normalize(userPath);
  const cleaned = normalizedInput.replace(/^[/\\]+/, "");
  const wsCandidate = resolve(workspaceRoot, cleaned);
  if (
    isSensitivePath(normalizedInput) ||
    isSensitivePath(wsCandidate)
  ) {
    return sensitivePathDenialMessage(userPath);
  }
  return `Access denied: path '${userPath}' is outside the workspace.`;
}

// ── Protected paths ──────────────────────────────────────
// Paths relative to workspace root that are off-limits for write tools.
// Read tools can still access these (the agent needs to read source code).
const WRITE_PROTECTED_PREFIXES = [
  ".git" + sep,     // Git internals — corruption risk
];

/** Check if a resolved path is write-protected. */
function isWriteProtected(resolved: string): boolean {
  const relToWorkspace = resolved.startsWith(workspaceRoot + sep)
    ? resolved.slice(workspaceRoot.length + 1)
    : null;
  if (!relToWorkspace) return false;
  return WRITE_PROTECTED_PREFIXES.some((prefix) => relToWorkspace.startsWith(prefix));
}

// ── Symlink escape protection ────────────────────────────

/**
 * Resolve a path and verify its real location (following symlinks)
 * is still within allowed boundaries. Returns null if the real path
 * escapes the jail.
 */
export async function jailPathReal(userPath: string): Promise<string | null> {
  const jailed = jailPath(userPath);
  if (!jailed) return null;

  try {
    const { realpath } = await import("node:fs/promises");
    const real = await realpath(jailed);
    // Return the *real* (symlink-resolved) path, not the original jailed
    // path. Returning `jailed` is a TOCTOU: an attacker can swap the
    // symlink target between validation and the caller's I/O. Returning
    // `real` means the caller operates on the exact file we validated.
    //
    // The sensitive-filename check runs on `real` so a benign-looking
    // symlink ("notes.txt" → "/path/to/.env") cannot launder past the
    // input-side check inside jailPath.
    if (isSensitivePath(real)) return null;
    if (real.startsWith(workspaceRoot + sep) || real === workspaceRoot) {
      return real;
    }
    for (const allowed of extraAllowedPaths) {
      if (real.startsWith(allowed + sep) || real === allowed) {
        return real;
      }
    }
    return null; // Symlink escapes jail
  } catch {
    // File doesn't exist yet (e.g. file_write creating new file) — use jailPath result
    return jailed;
  }
}

/**
 * Last-mile re-validation of a path that previously passed `jailPathReal`.
 *
 * jailPathReal resolves symlinks once and returns the canonical real path,
 * but there is a TOCTOU window between "validation passed" and the actual
 * fs syscall: an attacker with local write access can replace the resolved
 * path with a symlink pointing at /etc/passwd (or, on Windows, replace
 * the file with a junction) before our copy/move runs. Then `copyFile()`
 * follows the symlink and exfiltrates the target, and `rename()` moves
 * the symlink itself into a destination the agent later reads from.
 *
 * Mitigation: immediately before the syscall, re-lstat the canonical path
 * and re-realpath it. If lstat reports a symlink, abort. If realpath
 * returns a different canonical path than the one we already validated,
 * abort. This narrows the race window from the entire pre-syscall code
 * region to roughly two syscall round-trips — small enough that timing
 * an attacker swap precisely is not realistic on a normal host.
 *
 * Pure (no side effects); returns `null` on success or a reason string on
 * failure so callers can plumb the message into their error path.
 */
async function verifyStillSafe(
  resolvedPath: string,
  opts: { mustBeFile?: boolean } = {},
): Promise<string | null> {
  let l;
  try {
    l = await lstat(resolvedPath);
  } catch (err) {
    return `path no longer accessible: ${formatErrorMessage(err)}`;
  }
  if (l.isSymbolicLink()) {
    return "path was replaced with a symlink between validation and use";
  }
  if (opts.mustBeFile && !l.isFile()) {
    return "path is no longer a regular file";
  }
  let again: string;
  try {
    again = await realpath(resolvedPath);
  } catch (err) {
    return `realpath re-check failed: ${formatErrorMessage(err)}`;
  }
  if (again !== resolvedPath) {
    return `canonical path shifted between validation and use (was '${resolvedPath}', now '${again}')`;
  }
  return null;
}

// ── file_read ─────────────────────────────────────────────

const MAX_FILE_READ_BYTES = 512 * 1024; // 512 KB
const DEFAULT_LINE_LIMIT = 300;

async function handleFileRead(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const filePath = params.path as string;
  const offset = (params.offset as number | undefined) ?? 1;
  const limit = (params.limit as number | undefined) ?? DEFAULT_LINE_LIMIT;

  const resolved = await jailPathReal(filePath);
  if (!resolved) {
    return { content: jailDenialMessage(filePath), isError: true };
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { content: `'${filePath}' is not a file. Use glob_search to list directories.`, isError: true };
    }
    if (fileStat.size > MAX_FILE_READ_BYTES) {
      return {
        content: `File is too large (${(fileStat.size / 1024).toFixed(0)} KB). Max: ${MAX_FILE_READ_BYTES / 1024} KB. Use offset/limit to read a portion.`,
        isError: true,
      };
    }

    const raw = await readFile(resolved, "utf-8");
    const lines = raw.split("\n");
    const startIdx = Math.max(0, offset - 1); // 1-based → 0-based
    const sliced = lines.slice(startIdx, startIdx + limit);

    const totalLines = lines.length;
    const header = `[${relative(workspaceRoot, resolved)}] Lines ${startIdx + 1}-${Math.min(startIdx + limit, totalLines)} of ${totalLines}`;
    const truncated = sliced.length < totalLines - startIdx;

    return {
      content: `${header}\n${sliced.join("\n")}`,
      outputs: {
        path: resolved,
        content: sliced.join("\n"),
        lines: sliced.length,
        truncated,
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.includes("ENOENT")) {
      return { content: `File not found: '${filePath}'`, isError: true };
    }
    return { content: `Error reading file: ${msg}`, isError: true };
  }
}

// ── glob_search ───────────────────────────────────────────

const MAX_GLOB_RESULTS = 200;

async function handleGlobSearch(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const pattern = params.pattern as string;
  const searchPath = (params.path as string | undefined) ?? ".";

  const resolvedBase = await jailPathReal(searchPath);
  if (!resolvedBase) {
    return { content: `Access denied: path '${searchPath}' is outside the workspace.`, isError: true };
  }

  try {
    // Use Node.js 22+ fs.glob via readdir recursive + pattern matching
    const results = await collectGlob(resolvedBase, pattern);
    if (results.length === 0) {
      return {
        content: `No files found matching '${pattern}' in '${searchPath}'.`,
        outputs: { files: [], count: 0 },
      };
    }

    const shown = results.slice(0, MAX_GLOB_RESULTS);
    const display = shown.map((f) => relative(workspaceRoot, f)).join("\n");

    const truncated = results.length > MAX_GLOB_RESULTS
      ? `\n... and ${results.length - MAX_GLOB_RESULTS} more files`
      : "";

    return {
      content: `Found ${results.length} file(s):\n${display}${truncated}`,
      outputs: { files: shown, count: shown.length },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Glob error: ${msg}`, isError: true };
  }
}

/**
 * Simple recursive file listing with glob-style pattern matching.
 * Supports * and ** patterns without external dependencies.
 */
async function collectGlob(base: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or not a directory
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(base, fullPath);

      if (entry.isDirectory()) {
        // Skip node_modules, .git, and hidden dirs by default
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (regex.test(relPath) || regex.test(entry.name)) {
        results.push(fullPath);
        if (results.length >= MAX_GLOB_RESULTS * 2) return; // Safety cap
      }
    }
  }

  await walk(base);
  return results;
}

/** Convert a simple glob pattern to regex. */
function globToRegex(pattern: string): RegExp {
  // Pre-process {a,b,c} brace groups before escaping so they become regex
  // alternations (a|b|c). Models commonly use *.{mp4,mkv,mov} style patterns.
  const braceGroups: string[] = [];
  const S = "\x01"; // token start
  const E = "\x02"; // token end
  const withTokens = pattern.replace(/\{([^}]+)\}/g, (_, inner: string) => {
    const idx = braceGroups.length;
    const parts = (inner as string).split(",").map((p) =>
      p.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    );
    braceGroups.push(`(${parts.join("|")})`);
    return `${S}${idx}${E}`;
  });

  let escaped = withTokens
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLESTAR§")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/§DOUBLESTAR§/g, ".*")
    .replace(/\?/g, ".");

  // Restore brace groups as regex alternations
  braceGroups.forEach((group, idx) => {
    escaped = escaped.split(`${S}${idx}${E}`).join(group);
  });

  return new RegExp(`^${escaped}$|(?:^|[/\\\\])${escaped}$`, "i");
}

// ── shell ─────────────────────────────────────────────────

const MAX_SHELL_OUTPUT = 100 * 1024; // 100 KB
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/**
 * Environment variables that the child shell is allowed to see. We build
 * the child env from an allowlist rather than inheriting process.env
 * because the parent process holds API keys (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, CRABMEAT_TOKEN, CRABMEAT_ADMIN_TOKEN, $SECRET:* refs,
 * cloud credentials) that the agent must never be able to exfiltrate via
 * `echo $ANTHROPIC_API_KEY` or `env`. Only core vars a POSIX / Windows
 * shell needs to locate binaries and find the user's home directory pass
 * through.
 */
const SHELL_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Cross-platform core
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "COLORTERM", "TZ",
  // Temp dirs
  "TMP", "TEMP", "TMPDIR",
  // Windows — needed by cmd.exe to function
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS", "COMPUTERNAME", "USERDOMAIN", "USERNAME",
  "HOMEDRIVE", "HOMEPATH", "PUBLIC", "ALLUSERSPROFILE",
]);

function buildShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

/** Commands that should never be run. Case-insensitive patterns. */
const SHELL_DENYLIST: RegExp[] = [
  /\brm\s+(?:-{1,2}\S+\s+)*[/\\]/i,             // rm -rf / and split/long flag forms
  /\bformat\s+[a-z]:/i,                            // format C:
  /\bmkfs\b/i,                                     // mkfs
  /\bdd\s+.*\bof\s*=\s*\/dev\//i,                  // dd of=/dev/
  /\b(shutdown|reboot|halt|poweroff)\b/i,           // system shutdown
  /\breg\s+(delete|add)\s+.*\\\\HKLM/i,            // Windows registry modification
  /\bnet\s+user\b/i,                               // user account manipulation
  /\bchmod\s+.*\s+\/etc/i,                         // permission changes to /etc
  />\s*\/dev\/sd[a-z]/i,                            // overwrite block devices
  /\bcurl\b.*\|\s*(bash|sh|zsh|powershell|pwsh)/i, // pipe-to-shell
];

async function handleShell(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const command = params.command as string;
  const timeoutMs = (params.timeout as number | undefined) ?? DEFAULT_SHELL_TIMEOUT_MS;
  const dryRun = params.dry_run === true;
  const requestedCwd =
    typeof params.cwd === "string" && params.cwd.trim().length > 0
      ? params.cwd.trim()
      : undefined;

  // Denylist check — runs for dry_run too, so the preview reports blocked
  // commands instead of lying about what would happen.
  for (const pattern of SHELL_DENYLIST) {
    if (pattern.test(command)) {
      return {
        content: `Command denied by security policy. Matched denylist pattern: ${pattern.source}`,
        isError: true,
      };
    }
  }

  if (dryRun) {
    const parentOpId = "op_" + randomUUID().replace(/-/g, "");
    return {
      content: `DRY RUN — would execute${requestedCwd ? ` in ${requestedCwd}` : ""}: ${command}`,
      outputs: {
        stdout: "",
        stderr: "",
        exit_code: 0,
        timed_out: false,
        dry_run: true,
        parent_op_id: parentOpId,
      },
    };
  }

  let execCwd = workspaceRoot;
  if (requestedCwd) {
    const resolvedCwd = await jailPathReal(requestedCwd);
    if (!resolvedCwd) {
      return {
        content: `Access denied: cwd '${requestedCwd}' is outside allowed directories.`,
        isError: true,
      };
    }
    try {
      const cwdStat = await stat(resolvedCwd);
      if (!cwdStat.isDirectory()) {
        return {
          content: `Invalid cwd: '${requestedCwd}' is not a directory.`,
          isError: true,
        };
      }
      execCwd = resolvedCwd;
    } catch (err: unknown) {
      return {
        content: `Invalid cwd: '${requestedCwd}' is not accessible: ${formatErrorMessage(err)}`,
        isError: true,
      };
    }
  }

  const isWindows = platform() === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", command] : ["-c", command];
  const commandLength = command.length;
  const execStartedAt = Date.now();

  return new Promise((resolvePromise) => {
    const child = execFile(shell, shellArgs, {
      cwd: execCwd,
      timeout: timeoutMs,
      maxBuffer: MAX_SHELL_OUTPUT,
      // Allowlisted env — never inherit secrets from the parent. See
      // SHELL_ENV_ALLOWLIST above for the rationale.
      env: buildShellEnv(),
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const stdoutStr = stdout ?? "";
      const stderrStr = stderr ?? "";

      let output = "";
      if (stdoutStr) output += stdoutStr;
      if (stderrStr) output += (output ? "\n--- stderr ---\n" : "") + stderrStr;
      if (!output) output = "(no output)";

      // Cap output size
      if (output.length > MAX_SHELL_OUTPUT) {
        output = output.slice(0, MAX_SHELL_OUTPUT) + "\n... (output truncated)";
      }

      if (err) {
        const timedOut = Boolean(err.killed);
        const errCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const exitCode = timedOut
          ? -1
          : typeof errCode === "number"
            ? errCode
            : Number.parseInt(String(errCode ?? "-1"), 10) || -1;
        const errMsg = timedOut
          ? `Command timed out after ${timeoutMs}ms`
          : `Exit code: ${errCode ?? "unknown"}`;
        diagnostics.emit("exec.process.completed", {
          target: "host",
          outcome: "failed",
          durationMs: Date.now() - execStartedAt,
          commandLength,
          exitCode,
          timedOut,
          failureKind: timedOut ? "overall-timeout" : "runtime-error",
        });
        resolvePromise({
          content: `${errMsg}\n${output}`,
          isError: true,
          outputs: {
            stdout: stdoutStr,
            stderr: stderrStr,
            exit_code: exitCode,
            timed_out: timedOut,
            dry_run: false,
            cwd: execCwd,
          },
        });
        return;
      }

      diagnostics.emit("exec.process.completed", {
        target: "host",
        outcome: "completed",
        durationMs: Date.now() - execStartedAt,
        commandLength,
        exitCode: 0,
      });
      resolvePromise({
        content: output,
        outputs: {
          stdout: stdoutStr,
          stderr: stderrStr,
          exit_code: 0,
          timed_out: false,
          dry_run: false,
          cwd: execCwd,
        },
      });
    });

    // Safety: kill child if it spawns and somehow avoids timeout
    child.on("error", (spawnErr) => {
      diagnostics.emit("exec.process.completed", {
        target: "host",
        outcome: "failed",
        durationMs: Date.now() - execStartedAt,
        commandLength,
        failureKind: "shell-command-not-found",
      });
      resolvePromise({
        content: `Failed to spawn command: ${spawnErr.message}`,
        isError: true,
      });
    });
  });
}

// ── web_fetch ─────────────────────────────────────────────

const MAX_FETCH_BYTES = 200 * 1024; // 200 KB
const FETCH_TIMEOUT_MS = 15_000;

async function handleWebFetch(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const url = params.url as string;
  const maxLength = (params.maxLength as number | undefined) ?? 50_000;

  // SSRF check — reuse gateway's URL validator
  // web_fetch should allow public URLs but block private/metadata/link-local
  if (!isSafeBaseUrl(url, false)) {
    return {
      content: `URL blocked by SSRF protection: '${url}'. Only public HTTPS/HTTP URLs are allowed.`,
      isError: true,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "CrabMeat/0.1.0 (AI Gateway)",
        "Accept": "text/html, text/plain, application/json, */*",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    // Post-redirect SSRF re-check. fetch with redirect:"follow" silently
    // resolves redirects without re-validating each hop against
    // isSafeBaseUrl, so a public URL that 302s to 169.254.169.254 (cloud
    // metadata), 127.0.0.1, or any RFC 1918 host would otherwise return
    // the body verbatim. response.url is the final hop after redirect.
    const postRedirectUrl = response.url || url;
    if (postRedirectUrl !== url && !isSafeBaseUrl(postRedirectUrl, false)) {
      return {
        content: `URL blocked by SSRF protection: redirect chain ended at '${postRedirectUrl}'. Only public HTTPS/HTTP URLs are allowed.`,
        isError: true,
      };
    }

    if (!response.ok) {
      return {
        content: `HTTP ${response.status} ${response.statusText} for ${url}`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isText = /text|json|xml|javascript|html|css|csv|markdown/i.test(contentType);

    if (!isText) {
      return {
        content: `Non-text response (${contentType}). Only text content is supported.`,
        isError: true,
      };
    }

    const finalUrl = response.url || url;
    // Read as text with size cap
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      const decoded = new TextDecoder().decode(buffer.slice(0, MAX_FETCH_BYTES));
      const body = decoded.slice(0, maxLength);
      return {
        content: `[Truncated to ${MAX_FETCH_BYTES / 1024}KB]\n${body}`,
        outputs: {
          url: finalUrl,
          status: response.status,
          content: body,
          content_type: contentType,
          bytes: body.length,
          truncated: true,
        },
      };
    }

    const decoded = new TextDecoder().decode(buffer);
    const wasTruncated = decoded.length > maxLength;
    const body = wasTruncated ? decoded.slice(0, maxLength) : decoded;
    const displayText = wasTruncated ? body + "\n... (truncated)" : body;

    return {
      content: `[${response.status}] ${url}\n\n${displayText}`,
      outputs: {
        url: finalUrl,
        status: response.status,
        content: body,
        content_type: contentType,
        bytes: body.length,
        truncated: wasTruncated,
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.includes("abort")) {
      return { content: `Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`, isError: true };
    }
    return { content: `Fetch error: ${msg}`, isError: true };
  }
}

// ── weather ───────────────────────────────────────────────

async function handleWeather(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const location = params.location as string;
  const format = (params.format as string | undefined) ?? "3";

  const encoded = encodeURIComponent(location).replace(/%20/g, "+");
  const url = `https://wttr.in/${encoded}?format=${encodeURIComponent(format)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "CrabMeat/0.1.0 (AI Gateway)",
        "Accept": "text/plain",
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        content: `Weather lookup failed: HTTP ${response.status} for '${location}'.`,
        isError: true,
      };
    }

    const text = (await response.text()).trim();

    // wttr.in returns an HTML error page for unknown locations instead of 4xx.
    if (text.startsWith("<") || /<!doctype/i.test(text)) {
      return {
        content: `Could not resolve weather location '${location}'. Try a city name, airport code, or 'lat,lon'.`,
        isError: true,
      };
    }

    return {
      content: text,
      outputs: {
        location,
        report: text,
        format,
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.includes("abort")) {
      return {
        content: `Weather lookup timed out after ${FETCH_TIMEOUT_MS}ms: ${location}`,
        isError: true,
      };
    }
    return { content: `Weather lookup error: ${msg}`, isError: true };
  }
}

// ── file_write ────────────────────────────────────────────

const MAX_WRITE_BYTES = 512 * 1024; // 512 KB

/** Extensions that should never be overwritten with text content. */
const BINARY_EXTENSIONS = new Set([
  // Video
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg",
  // Audio
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a", ".opus",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".zst",
  // Executables / binaries
  ".exe", ".dll", ".so", ".dylib", ".bin", ".msi", ".deb", ".rpm",
  // Documents (binary)
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Databases
  ".db", ".sqlite", ".sqlite3",
]);

function isBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

async function handleFileWrite(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const filePath = params.path as string;
  const content = params.content as string;
  const dryRun = params.dry_run === true;
  const overwrite = params.overwrite === true;

  const resolved = await jailPathReal(filePath);
  if (!resolved) {
    return { content: `Access denied: path '${filePath}' is outside the workspace.`, isError: true };
  }

  // Guard: protect .git/ and other sensitive directories from writes
  if (isWriteProtected(resolved)) {
    return { content: `Access denied: '${filePath}' is in a protected directory.`, isError: true };
  }

  // Guard: refuse to overwrite binary files with text content.
  // This prevents the agent from destroying media/archives by writing
  // text to them when move/copy operations fail.
  if (isBinaryExtension(resolved)) {
    try {
      await stat(resolved);
      // File exists and has a binary extension — block the write
      return {
        content: `Refused: '${filePath}' is a binary file (${resolved.slice(resolved.lastIndexOf("."))}) and cannot be written with text content. Use file_move or file_copy instead.`,
        isError: true,
      };
    } catch {
      // File doesn't exist yet — still block; writing text to .mp4 etc. is never correct
      return {
        content: `Refused: cannot create a file with binary extension '${resolved.slice(resolved.lastIndexOf("."))}' using file_write. Binary files must be created through other means.`,
        isError: true,
      };
    }
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_BYTES) {
    return {
      content: `Content is too large (${(Buffer.byteLength(content, "utf-8") / 1024).toFixed(0)} KB). Max: ${MAX_WRITE_BYTES / 1024} KB.`,
      isError: true,
    };
  }

  // Read pre-existing file (if any) to report size + SHA-256. This surfaces
  // the destructive cost on dry_run *and* feeds the overwrite gate below —
  // the agent sees what it is about to obliterate before it does so.
  let preexisted = false;
  let priorSize = 0;
  let priorHash = "";
  try {
    const priorBuf = await readFile(resolved);
    preexisted = true;
    priorSize = priorBuf.byteLength;
    priorHash = createHash("sha256").update(priorBuf).digest("hex");
  } catch {
    preexisted = false;
  }

  const relPath = relative(workspaceRoot, resolved);
  const bytesToWrite = Buffer.byteLength(content, "utf-8");

  if (dryRun) {
    const parentOpId = "op_" + randomUUID().replace(/-/g, "");
    const head = preexisted
      ? `DRY RUN — would overwrite ${relPath} (${priorSize} B, sha256=${priorHash.slice(0, 12)}…) with ${bytesToWrite} B.`
      : `DRY RUN — would create ${relPath} (${bytesToWrite} B).`;
    return {
      content: head + " Pass dry_run:false (and overwrite:true if the file exists) to execute.",
      outputs: {
        path: resolved,
        bytes_written: 0,
        created: !preexisted,
        dry_run: true,
        prior_size: priorSize,
        prior_hash: priorHash,
        parent_op_id: parentOpId,
      },
    };
  }

  // Overwrite gate: a real write against an existing file requires explicit
  // overwrite:true. This forces the agent to have seen (or at least
  // acknowledged) that content is being destroyed.
  if (preexisted && !overwrite) {
    return {
      content:
        `Refused: '${relPath}' already exists (${priorSize} B, sha256=${priorHash.slice(0, 12)}…). ` +
        `Pass overwrite:true to replace it, or use file_edit to modify in place, or dry_run:true to preview.`,
      isError: true,
      outputs: {
        path: resolved,
        bytes_written: 0,
        created: false,
        dry_run: false,
        prior_size: priorSize,
        prior_hash: priorHash,
      },
    };
  }

  try {
    // Atomic write: tmp-then-rename. A crash mid-syscall leaves either
    // the prior contents or the new contents on disk, never a truncated
    // half-written blob.
    await writeFileAtomic(resolved, content);

    const lines = content.split("\n").length;
    return {
      content: `Wrote ${lines} lines to ${relPath}`,
      outputs: {
        path: resolved,
        bytes_written: bytesToWrite,
        created: !preexisted,
        dry_run: false,
        prior_size: priorSize,
        prior_hash: priorHash,
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Error writing file: ${msg}`, isError: true };
  }
}

// ── memory_write ──────────────────────────────────────────

const MEMORY_DIR = ".crabmeat/memory";
const MAX_MEMORY_VALUE = 100 * 1024; // 100 KB per entry
// Per-file safe-append cap: bigger files force the agent to rotate or
// switch to overwrite mode, since the atomic-append path rewrites the
// whole file.
const MAX_MEMORY_FILE_BYTES = 1024 * 1024;

async function handleMemoryWrite(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const key = params.key as string;
  const content = params.content as string;
  const mode = (params.mode as string | undefined) ?? "append";

  // Sanitize key: only alphanumeric, dashes, underscores, dots
  if (!/^[a-zA-Z0-9_\-.]+$/.test(key)) {
    return { content: `Invalid memory key '${key}'. Use only letters, numbers, dashes, underscores, dots.`, isError: true };
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_MEMORY_VALUE) {
    return { content: `Content too large. Max: ${MAX_MEMORY_VALUE / 1024} KB per write.`, isError: true };
  }

  try {
    const memDir = join(workspaceRoot, MEMORY_DIR);
    await mkdir(memDir, { recursive: true });
    const filePath = join(memDir, `${key}.md`);

    const effectiveMode = mode === "overwrite" ? "overwrite" : "append";
    let bytesWritten: number;
    if (effectiveMode === "overwrite") {
      // Atomic: a crash during the syscall must not lose the previous
      // contents and leave a half-written file in their place.
      await writeFileAtomic(filePath, content);
      bytesWritten = Buffer.byteLength(content, "utf-8");
    } else {
      // Append-with-rewrite: read prior contents, concatenate the new
      // entry, then atomically replace. fs.appendFile is not crash-safe
      // (a partial write extends the file by garbage). The 1 MB read cap
      // protects against runaway memory files; over the cap, the agent
      // must rotate or use overwrite mode explicitly.
      const timestamp = new Date().toISOString();
      const entry = `\n---\n_${timestamp}_\n\n${content}\n`;
      let prior = "";
      try {
        const buf = await readFile(filePath);
        if (buf.byteLength > MAX_MEMORY_FILE_BYTES) {
          return {
            content:
              `Memory '${key}' is over the ${MAX_MEMORY_FILE_BYTES / 1024} KB safe-append cap (currently ${(buf.byteLength / 1024).toFixed(0)} KB). Rotate or use mode:"overwrite".`,
            isError: true,
          };
        }
        prior = buf.toString("utf-8");
      } catch (err: unknown) {
        const msg = formatErrorMessage(err);
        if (!msg.includes("ENOENT")) throw err;
      }
      await writeFileAtomic(filePath, prior + entry);
      bytesWritten = Buffer.byteLength(entry, "utf-8");
    }

    return {
      content: `Memory '${key}' ${effectiveMode === "overwrite" ? "saved" : "updated"} (${MEMORY_DIR}/${key}.md)`,
      outputs: { key, mode: effectiveMode, bytes_written: bytesWritten },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Error writing memory: ${msg}`, isError: true };
  }
}

// ── memory_read ───────────────────────────────────────────

async function handleMemoryRead(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const key = params.key as string | undefined;

  try {
    const memDir = join(workspaceRoot, MEMORY_DIR);

    // No key → list all memory files
    if (!key) {
      let entries;
      try {
        entries = await readdir(memDir);
      } catch {
        return {
          content: "No memories saved yet.",
          outputs: { key: "", content: "", exists: false, keys: [] },
        };
      }
      const mdFiles = entries.filter((e) => e.endsWith(".md"));
      const keyNames = mdFiles.map((f) => f.replace(".md", ""));
      if (mdFiles.length === 0) {
        return {
          content: "No memories saved yet.",
          outputs: { key: "", content: "", exists: false, keys: [] },
        };
      }
      return {
        content: `Memory keys:\n${keyNames.map((k) => `- ${k}`).join("\n")}`,
        outputs: { key: "", content: "", exists: true, keys: keyNames },
      };
    }

    // Sanitize key
    if (!/^[a-zA-Z0-9_\-.]+$/.test(key)) {
      return { content: `Invalid memory key '${key}'.`, isError: true };
    }

    const filePath = join(memDir, `${key}.md`);
    const raw = await readFile(filePath, "utf-8");
    const body = raw.length > MAX_TEXT_LENGTH ? raw.slice(0, MAX_TEXT_LENGTH) : raw;
    const suffix = raw.length > MAX_TEXT_LENGTH ? "\n... (truncated)" : "";

    return {
      content: body + suffix,
      outputs: { key, content: body, exists: true },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.includes("ENOENT")) {
      return {
        content: `Memory '${key}' not found.`,
        isError: true,
        outputs: { key: key ?? "", content: "", exists: false },
      };
    }
    return { content: `Error reading memory: ${msg}`, isError: true };
  }
}

const MAX_TEXT_LENGTH = 50_000;

// ── timer ────────────────────────────────────────────────

/**
 * Per-session wall-clock timers.
 * Keyed by `${sessionKey}\0${label}` to isolate across sessions.
 * Uses monotonic hrtime to prevent clock-skew hallucinations.
 */
const activeTimers = new Map<string, bigint>();
const MAX_TIMERS_PER_SESSION = 20;

function timerKey(sessionKey: string, label: string): string {
  return sessionKey + "\0" + label;
}

function countSessionTimers(sessionKey: string): number {
  let count = 0;
  const prefix = sessionKey + "\0";
  for (const key of activeTimers.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

function formatDuration(ns: bigint): string {
  const totalMs = Number(ns / 1_000_000n);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = ((totalMs % 60_000) / 1000).toFixed(2);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ") + ` (${(totalMs / 1000).toFixed(2)}s total)`;
}

async function handleTimer(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: import("./types.js").ToolExecutionContext,
): Promise<BuiltinResult> {
  const action = params.action as string;
  const label = (params.label as string | undefined) ?? "default";
  const sessionKey = context?.sessionKey ?? "_global";

  if (!/^[a-zA-Z0-9_\- ]{1,64}$/.test(label)) {
    return { content: "Invalid timer label. Use letters, numbers, dashes, underscores, spaces (max 64 chars).", isError: true };
  }

  const key = timerKey(sessionKey, label);

  switch (action) {
    case "start": {
      if (activeTimers.has(key)) {
        return { content: `Timer '${label}' is already running. Stop it first or use a different label.`, isError: true };
      }
      if (countSessionTimers(sessionKey) >= MAX_TIMERS_PER_SESSION) {
        return { content: `Too many active timers (max ${MAX_TIMERS_PER_SESSION}). Stop some first.`, isError: true };
      }
      activeTimers.set(key, process.hrtime.bigint());
      return {
        content: `Timer '${label}' started.`,
        outputs: { action: "start", label, elapsed_ms: 0, running: true },
      };
    }
    case "check": {
      const startTime = activeTimers.get(key);
      if (!startTime) {
        return { content: `No active timer '${label}'. Start one first.`, isError: true };
      }
      const elapsed = process.hrtime.bigint() - startTime;
      return {
        content: `Timer '${label}' running: ${formatDuration(elapsed)}`,
        outputs: {
          action: "check",
          label,
          elapsed_ms: Number(elapsed / 1_000_000n),
          running: true,
        },
      };
    }
    case "stop": {
      const startTime = activeTimers.get(key);
      if (!startTime) {
        return { content: `No active timer '${label}'. Nothing to stop.`, isError: true };
      }
      const elapsed = process.hrtime.bigint() - startTime;
      activeTimers.delete(key);
      return {
        content: `Timer '${label}' stopped: ${formatDuration(elapsed)}`,
        outputs: {
          action: "stop",
          label,
          elapsed_ms: Number(elapsed / 1_000_000n),
          running: false,
        },
      };
    }
    case "list": {
      const prefix = sessionKey + "\0";
      const entries: string[] = [];
      const timers: Array<{ label: string; elapsed_ms: number }> = [];
      const now = process.hrtime.bigint();
      for (const [k, startTime] of activeTimers) {
        if (k.startsWith(prefix)) {
          const timerLabel = k.slice(prefix.length);
          const elapsed = now - startTime;
          entries.push(`  ${timerLabel}: ${formatDuration(elapsed)}`);
          timers.push({ label: timerLabel, elapsed_ms: Number(elapsed / 1_000_000n) });
        }
      }
      if (entries.length === 0) {
        return {
          content: "No active timers.",
          outputs: { action: "list", timers: [] },
        };
      }
      return {
        content: `Active timers (${entries.length}):\n${entries.join("\n")}`,
        outputs: { action: "list", timers },
      };
    }
    default:
      return { content: `Unknown timer action '${action}'. Use: start, check, stop, list.`, isError: true };
  }
}

// ── random ───────────────────────────────────────────────

/**
 * True random number generation backed by crypto.randomInt().
 * No more "7 every time" — real entropy from the OS.
 */
async function handleRandom(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const { randomInt, randomUUID, randomBytes } = await import("node:crypto");

  const mode = (params.mode as string | undefined) ?? "integer";

  switch (mode) {
    case "integer": {
      const min = params.min != null ? Math.round(Number(params.min)) : 1;
      const max = params.max != null ? Math.round(Number(params.max)) : 10;
      if (Number.isNaN(min) || Number.isNaN(max)) {
        return { content: "min and max must be numbers.", isError: true };
      }
      if (min >= max) {
        return { content: "min must be less than max.", isError: true };
      }
      if (max - min > 1_000_000_000) {
        return { content: "Range too large (max 1 billion).", isError: true };
      }
      // crypto.randomInt is exclusive on upper bound, so +1
      const value = randomInt(min, max + 1);
      return {
        content: `Your random number between ${min} and ${max} is **${value}**.`,
        outputs: { mode: "integer", value_int: value },
      };
    }
    case "float": {
      // Generate a cryptographically random float in [0, 1)
      const buf = randomBytes(8);
      const raw = buf.readBigUInt64BE();
      const value = Number(raw) / Number(2n ** 64n);
      return {
        content: `Random float: **${value}**`,
        outputs: { mode: "float", value_float: value },
      };
    }
    case "uuid": {
      const value = randomUUID();
      return {
        content: `Here's a UUID: \`${value}\``,
        outputs: { mode: "uuid", value_string: value },
      };
    }
    case "choice": {
      // Accept array or comma-separated string (Layer 0 passes strings)
      let options: string[];
      if (Array.isArray(params.options)) {
        options = params.options.map(String);
      } else if (typeof params.options === "string" && params.options.length > 0) {
        options = params.options.split(/,\s*/).map((s: string) => s.trim()).filter(Boolean);
      } else {
        return { content: "options must be a non-empty array or comma-separated string.", isError: true };
      }
      if (options.length === 0) {
        return { content: "options must contain at least one item.", isError: true };
      }
      if (options.length > 10_000) {
        return { content: "Too many options (max 10,000).", isError: true };
      }
      const idx = randomInt(0, options.length);
      const choice = options[idx]!;
      return {
        content: `I picked **${choice}**.`,
        outputs: { mode: "choice", value_string: choice },
      };
    }
    case "dice": {
      const count = params.count != null ? Math.round(Number(params.count)) : 1;
      const sides = params.sides != null ? Math.round(Number(params.sides)) : 6;
      if (Number.isNaN(count) || count < 1 || count > 100) {
        return { content: "count must be an integer 1-100.", isError: true };
      }
      if (Number.isNaN(sides) || sides < 2 || sides > 1000) {
        return { content: "sides must be an integer 2-1000.", isError: true };
      }
      const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      if (count === 1) {
        return {
          content: `You rolled a **${rolls[0]}**.`,
          outputs: { mode: "dice", value_int: rolls[0]!, values: rolls },
        };
      }
      return {
        content: `You rolled [${rolls.join(", ")}] for a total of **${total}**.`,
        outputs: { mode: "dice", value_int: total, values: rolls },
      };
    }
    default:
      return { content: `Unknown mode '${mode}'. Use: integer, float, uuid, choice, dice.`, isError: true };
  }
}

// ── file_move ─────────────────────────────────────────────

/**
 * Move a single file from resolvedSrc to resolvedDst.
 * Handles cross-device moves via copy+delete fallback.
 */
async function moveOneFile(resolvedSrc: string, resolvedDst: string): Promise<void> {
  await mkdir(dirname(resolvedDst), { recursive: true });
  try {
    await rename(resolvedSrc, resolvedDst);
  } catch (renameErr: unknown) {
    const code = (renameErr as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      await copyFile(resolvedSrc, resolvedDst);
      await unlink(resolvedSrc);
    } else {
      throw renameErr;
    }
  }
}

interface BulkPlanItem {
  source: string;
  destination: string;
  resolvedSrc: string;
  resolvedDst: string;
  bytes: number;
}

interface BulkFailureItem {
  source: string;
  error: string;
}

/**
 * Resolve and validate a batch of (source → destination) pairs without
 * touching disk for the move/copy itself. Used both by dry_run (to preview)
 * and by the execute path (to check all sources before any destructive action
 * happens).
 */
async function buildBulkFilePlan(
  sourceList: string[],
  destination: string,
): Promise<{ plan: BulkPlanItem[]; failed: BulkFailureItem[] }> {
  const destIsDir = destination.endsWith("/") || destination.endsWith("\\");
  const plan: BulkPlanItem[] = [];
  const failed: BulkFailureItem[] = [];

  for (const source of sourceList) {
    const resolvedSrc = await jailPathReal(source);
    if (!resolvedSrc) {
      failed.push({ source, error: `Access denied: '${source}' is outside allowed directories.` });
      continue;
    }

    let destPath = destination;
    if (destIsDir || sourceList.length > 1) {
      destPath = join(destination, basename(resolvedSrc));
    }

    const resolvedDst = await jailPathReal(destPath);
    if (!resolvedDst) {
      failed.push({ source, error: `Access denied: destination '${destPath}' is outside allowed directories.` });
      continue;
    }

    if (isWriteProtected(resolvedDst)) {
      failed.push({ source, error: `Access denied: destination '${destPath}' is in a protected directory.` });
      continue;
    }

    try {
      const srcStat = await stat(resolvedSrc);
      if (!srcStat.isFile()) {
        failed.push({ source, error: `'${source}' is not a file.` });
        continue;
      }
      plan.push({
        source,
        destination: destPath,
        resolvedSrc,
        resolvedDst,
        bytes: srcStat.size,
      });
    } catch (err: unknown) {
      failed.push({ source, error: formatErrorMessage(err) });
    }
  }

  return { plan, failed };
}

function parseSourceList(params: Record<string, unknown>): string[] {
  const rawSource = params.source ?? params.sources;
  return Array.isArray(rawSource)
    ? (rawSource as string[])
    : typeof rawSource === "string"
      ? [rawSource]
      : [];
}

function formatPlanBlock(verb: string, plan: BulkPlanItem[], failed: BulkFailureItem[]): string {
  const lines: string[] = [];
  lines.push(`Plan: ${verb} ${plan.length} file(s)`);
  for (const item of plan) {
    lines.push(`  ${item.source} → ${item.destination}  (${item.bytes} B)`);
  }
  if (failed.length > 0) {
    lines.push(`Invalid (will be skipped): ${failed.length}`);
    for (const f of failed) {
      lines.push(`  ✗ ${f.source}: ${f.error}`);
    }
  }
  return lines.join("\n");
}

async function handleFileMove(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const destination = params.destination as string;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!destination) {
    return { content: "The 'destination' parameter is required.", isError: true };
  }

  const sourceList = parseSourceList(params);
  if (sourceList.length === 0) {
    return { content: "Provide 'source' (string) or 'sources' (array of strings).", isError: true };
  }

  const { plan, failed } = await buildBulkFilePlan(sourceList, destination);
  const fingerprint = planFingerprint(
    "file_move",
    plan.map((p) => ({ src: p.resolvedSrc, dst: p.resolvedDst })),
  );
  const totalBytes = plan.reduce((sum, item) => sum + item.bytes, 0);

  // Explicit dry-run preview
  if (dryRun) {
    const parentOpId = "op_" + randomUUID().replace(/-/g, "");
    const token = mintConfirmToken(fingerprint);
    const planText = formatPlanBlock("move", plan, failed);
    return {
      content: `DRY RUN — file_move\n${planText}\nTotal: ${totalBytes} B\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        moved: [],
        failed,
        count: 0,
        dry_run: true,
        plan: plan.map((p) => ({ source: p.source, destination: p.destination, bytes: p.bytes })),
        total_bytes: totalBytes,
        confirm_token: token,
        parent_op_id: parentOpId,
      },
    };
  }

  // Threshold auto-preview: bulk moves over the limit require a matching
  // confirm_token. First call without the token returns the plan and a fresh
  // token; the follow-up call carrying that token proceeds to execute.
  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const parentOpId = "op_" + randomUUID().replace(/-/g, "");
      const token = mintConfirmToken(fingerprint);
      const planText = formatPlanBlock("move", plan, failed);
      return {
        content:
          `Refused: file_move of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — re-send the same call with confirm_token to execute, or pass dry_run:true to inspect further.\n` +
          planText,
        isError: true,
        outputs: {
          moved: [],
          failed,
          count: 0,
          dry_run: true,
          plan: plan.map((p) => ({ source: p.source, destination: p.destination, bytes: p.bytes })),
          total_bytes: totalBytes,
          confirm_token: token,
          parent_op_id: parentOpId,
        },
      };
    }
  }

  const results: string[] = [];
  const errors: string[] = [...failed.map((f) => `✗ ${f.source}: ${f.error}`)];
  const moved: string[] = [];
  const failedFinal: BulkFailureItem[] = [...failed];

  for (const item of plan) {
    try {
      // Last-mile TOCTOU re-check: jailPathReal validated the symlink-free
      // canonical path, but a swap-attack could replace it with a symlink
      // before rename runs, causing a symlink to be moved into the dest
      // (where the agent might later read through it).
      const swapReason = await verifyStillSafe(item.resolvedSrc, { mustBeFile: true });
      if (swapReason) {
        const reason = `'${item.source}': ${swapReason}`;
        errors.push(reason);
        failedFinal.push({ source: item.source, error: swapReason });
        continue;
      }

      await moveOneFile(item.resolvedSrc, item.resolvedDst);
      results.push(`✓ ${item.source} → ${item.destination}`);
      moved.push(item.resolvedDst);
    } catch (err: unknown) {
      const msg = formatErrorMessage(err);
      errors.push(`✗ ${item.source}: ${msg}`);
      failedFinal.push({ source: item.source, error: msg });
    }
  }

  const lines = [...results, ...errors];
  const summary = `Moved ${results.length}/${sourceList.length} file(s)`;
  return {
    content: `${summary}\n${lines.join("\n")}`,
    isError: errors.length > 0 && results.length === 0,
    outputs: {
      moved,
      failed: failedFinal,
      count: moved.length,
      dry_run: false,
    },
  };
}

// ── file_copy ─────────────────────────────────────────────

async function handleFileCopy(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const destination = params.destination as string;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!destination) {
    return { content: "The 'destination' parameter is required.", isError: true };
  }

  const sourceList = parseSourceList(params);
  if (sourceList.length === 0) {
    return { content: "Provide 'source' (string) or 'sources' (array of strings).", isError: true };
  }

  const { plan, failed } = await buildBulkFilePlan(sourceList, destination);
  const fingerprint = planFingerprint(
    "file_copy",
    plan.map((p) => ({ src: p.resolvedSrc, dst: p.resolvedDst })),
  );
  const totalBytes = plan.reduce((sum, item) => sum + item.bytes, 0);

  if (dryRun) {
    const parentOpId = "op_" + randomUUID().replace(/-/g, "");
    const token = mintConfirmToken(fingerprint);
    const planText = formatPlanBlock("copy", plan, failed);
    return {
      content: `DRY RUN — file_copy\n${planText}\nTotal: ${totalBytes} B\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        copied: [],
        failed,
        count: 0,
        dry_run: true,
        plan: plan.map((p) => ({ source: p.source, destination: p.destination, bytes: p.bytes })),
        total_bytes: totalBytes,
        confirm_token: token,
        parent_op_id: parentOpId,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const parentOpId = "op_" + randomUUID().replace(/-/g, "");
      const token = mintConfirmToken(fingerprint);
      const planText = formatPlanBlock("copy", plan, failed);
      return {
        content:
          `Refused: file_copy of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — re-send the same call with confirm_token to execute, or pass dry_run:true to inspect further.\n` +
          planText,
        isError: true,
        outputs: {
          copied: [],
          failed,
          count: 0,
          dry_run: true,
          plan: plan.map((p) => ({ source: p.source, destination: p.destination, bytes: p.bytes })),
          total_bytes: totalBytes,
          confirm_token: token,
          parent_op_id: parentOpId,
        },
      };
    }
  }

  const results: string[] = [];
  const errors: string[] = [...failed.map((f) => `✗ ${f.source}: ${f.error}`)];
  const copied: string[] = [];
  const failedFinal: BulkFailureItem[] = [...failed];

  for (const item of plan) {
    try {
      // Last-mile TOCTOU re-check: copyFile follows symlinks, so a swap
      // between jailPathReal and now could cause us to copy /etc/passwd
      // (or another sensitive file) into the workspace under a benign name.
      const swapReason = await verifyStillSafe(item.resolvedSrc, { mustBeFile: true });
      if (swapReason) {
        const reason = `'${item.source}': ${swapReason}`;
        errors.push(reason);
        failedFinal.push({ source: item.source, error: swapReason });
        continue;
      }

      await mkdir(dirname(item.resolvedDst), { recursive: true });
      await copyFile(item.resolvedSrc, item.resolvedDst);
      results.push(`✓ ${item.source} → ${item.destination}`);
      copied.push(item.resolvedDst);
    } catch (err: unknown) {
      const msg = formatErrorMessage(err);
      errors.push(`✗ ${item.source}: ${msg}`);
      failedFinal.push({ source: item.source, error: msg });
    }
  }

  const lines = [...results, ...errors];
  const summary = `Copied ${results.length}/${sourceList.length} file(s)`;
  return {
    content: `${summary}\n${lines.join("\n")}`,
    isError: errors.length > 0 && results.length === 0,
    outputs: {
      copied,
      failed: failedFinal,
      count: copied.length,
      dry_run: false,
    },
  };
}

// ── file_edit ─────────────────────────────────────────────

const MAX_EDIT_FILE_BYTES = 512 * 1024;

async function handleFileEdit(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const filePath = params.path as string;
  const oldString = params.old_string as string;
  const newString = params.new_string as string;
  const replaceAll = (params.replace_all as boolean | undefined) ?? false;

  if (oldString === newString) {
    return { content: "old_string and new_string are identical — nothing to change.", isError: true };
  }
  if (oldString.length === 0) {
    return { content: "old_string must not be empty. Use file_write to create a new file.", isError: true };
  }

  const resolved = await jailPathReal(filePath);
  if (!resolved) {
    return { content: `Access denied: path '${filePath}' is outside the workspace.`, isError: true };
  }
  if (isWriteProtected(resolved)) {
    return { content: `Access denied: '${filePath}' is in a protected directory.`, isError: true };
  }
  if (isBinaryExtension(resolved)) {
    return { content: `Refused: '${filePath}' has a binary extension and cannot be edited as text.`, isError: true };
  }

  let original: string;
  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { content: `'${filePath}' is not a file.`, isError: true };
    }
    if (fileStat.size > MAX_EDIT_FILE_BYTES) {
      return {
        content: `File is too large to edit (${(fileStat.size / 1024).toFixed(0)} KB). Max: ${MAX_EDIT_FILE_BYTES / 1024} KB.`,
        isError: true,
      };
    }
    original = await readFile(resolved, "utf-8");
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    if (msg.includes("ENOENT")) {
      return { content: `File not found: '${filePath}'. Use file_write to create it.`, isError: true };
    }
    return { content: `Error reading file: ${msg}`, isError: true };
  }

  // Count occurrences
  let count = 0;
  let idx = original.indexOf(oldString);
  while (idx !== -1) {
    count++;
    idx = original.indexOf(oldString, idx + oldString.length);
    if (count > 10_000) break; // safety cap
  }

  if (count === 0) {
    return {
      content: `old_string not found in '${filePath}'. Read the file first to get exact content including whitespace.`,
      isError: true,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      content: `old_string matched ${count} locations in '${filePath}'. Provide more context to make it unique, or set replace_all: true.`,
      isError: true,
    };
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  if (Buffer.byteLength(updated, "utf-8") > MAX_WRITE_BYTES) {
    return {
      content: `Edited content would exceed the ${MAX_WRITE_BYTES / 1024} KB write cap.`,
      isError: true,
    };
  }

  try {
    // Atomic replacement: a crash mid-write must not destroy both the
    // original and the edited contents. tmp-then-rename leaves either
    // the prior file or the edited file on disk.
    await writeFileAtomic(resolved, updated);
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Error writing file: ${msg}`, isError: true };
  }

  const relPath = relative(workspaceRoot, resolved).replace(/\\/g, "/");
  const replaced = replaceAll ? count : 1;
  const oldLines = oldString.split("\n").length;
  const newLines = newString.split("\n").length;
  const delta = newLines - oldLines;
  const deltaStr = delta === 0 ? "" : delta > 0 ? ` (+${delta} lines)` : ` (${delta} lines)`;
  return {
    content: `Edited ${relPath}: ${replaced} replacement${replaced === 1 ? "" : "s"}${deltaStr}`,
    outputs: { path: resolved, replacements: replaced },
  };
}

// ── grep_search ───────────────────────────────────────────

const MAX_GREP_RESULTS = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024; // skip files over 1 MB
const MAX_GREP_LINE_LENGTH = 500; // truncate long lines in output

async function handleGrepSearch(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const pattern = params.pattern as string;
  const searchPath = (params.path as string | undefined) ?? ".";
  const globFilter = params.glob as string | undefined;
  const ignoreCase = (params.ignore_case as boolean | undefined) ?? false;
  const filesOnly = (params.files_only as boolean | undefined) ?? false;
  const maxResults = Math.min(
    (params.max_results as number | undefined) ?? MAX_GREP_RESULTS,
    MAX_GREP_RESULTS,
  );

  if (!pattern) {
    return { content: "pattern is required.", isError: true };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Invalid regex: ${msg}`, isError: true };
  }

  const base = await jailPathReal(searchPath);
  if (!base) {
    return { content: `Access denied: path '${searchPath}' is outside the workspace.`, isError: true };
  }

  const globRegex = globFilter ? globToRegex(globFilter) : null;

  const matches: Array<{ file: string; line: number; text: string }> = [];
  const filesMatched = new Set<string>();
  let filesScanned = 0;
  let truncated = false;

  /** Scan a single file's contents against the regex. Returns true if caller should stop (hit cap). */
  const scanFile = async (fullPath: string): Promise<boolean> => {
    try {
      const st = await stat(fullPath);
      if (st.size > MAX_GREP_FILE_BYTES) return false;
      filesScanned++;
      const raw = await readFile(fullPath, "utf-8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!regex.test(line)) continue;
        filesMatched.add(fullPath);
        if (filesOnly) return false; // one hit per file is enough
        const text = line.length > MAX_GREP_LINE_LENGTH
          ? line.slice(0, MAX_GREP_LINE_LENGTH) + "…"
          : line;
        matches.push({ file: fullPath, line: i + 1, text });
        if (matches.length >= maxResults) {
          truncated = true;
          return true;
        }
      }
    } catch {
      // unreadable file — skip silently
    }
    return false;
  };

  const walk = async (dir: string): Promise<void> => {
    if (matches.length >= maxResults) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = relative(base, fullPath).replace(/\\/g, "/");
      if (globRegex && !globRegex.test(relPath) && !globRegex.test(entry.name)) {
        continue;
      }
      if (isBinaryExtension(fullPath)) continue;
      const stop = await scanFile(fullPath);
      if (stop) return;
    }
  };

  try {
    const baseStat = await stat(base);
    if (baseStat.isFile()) {
      await scanFile(base);
    } else {
      await walk(base);
    }
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Grep error: ${msg}`, isError: true };
  }

  const toRel = (f: string): string => relative(workspaceRoot, f).replace(/\\/g, "/");

  if (filesOnly) {
    if (filesMatched.size === 0) {
      return {
        content: `No files matched '${pattern}' (scanned ${filesScanned}).`,
        outputs: { matches: [], count: 0, truncated: false },
      };
    }
    const sortedFiles = [...filesMatched].map(toRel).sort();
    const list = sortedFiles.join("\n");
    const suffix = truncated ? `\n… (truncated at ${maxResults})` : "";
    return {
      content: `${filesMatched.size} file(s) matched (scanned ${filesScanned}):\n${list}${suffix}`,
      outputs: { matches: sortedFiles, count: sortedFiles.length, truncated },
    };
  }

  if (matches.length === 0) {
    return {
      content: `No matches for '${pattern}' (scanned ${filesScanned} file(s)).`,
      outputs: { matches: [], count: 0, truncated: false },
    };
  }

  const structured = matches.map((m) => ({
    path: toRel(m.file),
    line: m.line,
    text: m.text,
  }));
  const lines = structured.map((m) => `${m.path}:${m.line}: ${m.text}`);
  const suffix = truncated ? `\n… (truncated at ${maxResults} matches)` : "";
  return {
    content: `${matches.length} match(es) in ${filesMatched.size} file(s), scanned ${filesScanned}:\n${lines.join("\n")}${suffix}`,
    outputs: { matches: structured, count: structured.length, truncated },
  };
}

// ── file_list ─────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function handleFileList(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const dirPath = (params.path as string | undefined) ?? ".";

  const resolved = await jailPathReal(dirPath);
  if (!resolved) {
    return { content: `Access denied: path '${dirPath}' is outside allowed directories.`, isError: true };
  }

  try {
    const dirStat = await stat(resolved);
    if (!dirStat.isDirectory()) {
      return { content: `'${dirPath}' is not a directory.`, isError: true };
    }

    const entries = await readdir(resolved, { withFileTypes: true });
    if (entries.length === 0) {
      return {
        content: `Directory '${dirPath}' is empty.`,
        outputs: { path: resolved, entries: [], count: 0 },
      };
    }

    // Cap listing to 500 entries
    const cap = 500;
    const limited = entries.slice(0, cap);

    const lines: string[] = [];
    const structuredEntries: Array<{ name: string; type: string; size: number }> = [];
    for (const entry of limited) {
      const entryPath = join(resolved, entry.name);
      if (entry.isDirectory()) {
        lines.push(`📁 ${entry.name}/`);
        structuredEntries.push({ name: entry.name, type: "directory", size: 0 });
      } else if (entry.isFile()) {
        let size = 0;
        try {
          const fileStat = await stat(entryPath);
          size = fileStat.size;
          lines.push(`📄 ${entry.name}  (${formatBytes(size)})`);
        } catch {
          lines.push(`📄 ${entry.name}`);
        }
        structuredEntries.push({ name: entry.name, type: "file", size });
      } else {
        lines.push(`   ${entry.name}`);
        structuredEntries.push({ name: entry.name, type: "other", size: 0 });
      }
    }

    let header = `Directory: ${dirPath} (${entries.length} entries)`;
    if (entries.length > cap) {
      header += ` — showing first ${cap}`;
    }

    return {
      content: `${header}\n\n${lines.join("\n")}`,
      outputs: {
        path: resolved,
        entries: structuredEntries,
        count: structuredEntries.length,
      },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    return { content: `Error listing directory: ${msg}`, isError: true };
  }
}

// ── ask_user ──────────────────────────────────────────────

const MAX_ASK_QUESTION_LEN = 2000;
const MAX_ASK_OPTIONS = 8;
const MAX_ASK_OPTION_LEN = 200;

async function handleAskUser(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: import("./types.js").ToolExecutionContext,
): Promise<BuiltinResult> {
  if (!context?.sessionKey) {
    return {
      content: "ask_user is only available inside an active user session.",
      isError: true,
    };
  }

  const question = typeof params.question === "string" ? params.question.trim() : "";
  if (!question) {
    return { content: "ask_user: 'question' is required.", isError: true };
  }
  if (question.length > MAX_ASK_QUESTION_LEN) {
    return {
      content: `ask_user: question too long (${question.length} > ${MAX_ASK_QUESTION_LEN}).`,
      isError: true,
    };
  }

  let options: string[] = [];
  if (params.options !== undefined) {
    if (!Array.isArray(params.options)) {
      return { content: "ask_user: 'options' must be an array of strings.", isError: true };
    }
    if (params.options.length > MAX_ASK_OPTIONS) {
      return {
        content: `ask_user: too many options (max ${MAX_ASK_OPTIONS}).`,
        isError: true,
      };
    }
    for (const opt of params.options) {
      if (typeof opt !== "string" || opt.length === 0) {
        return { content: "ask_user: each option must be a non-empty string.", isError: true };
      }
      if (opt.length > MAX_ASK_OPTION_LEN) {
        return {
          content: `ask_user: option too long (max ${MAX_ASK_OPTION_LEN} chars).`,
          isError: true,
        };
      }
      options.push(opt);
    }
  }

  const allowFreeform = params.allow_freeform === undefined
    ? true
    : Boolean(params.allow_freeform);

  let timeoutMs = DEFAULT_ASK_TIMEOUT_MS;
  if (typeof params.timeout_ms === "number" && Number.isFinite(params.timeout_ms)) {
    timeoutMs = Math.max(MIN_ASK_TIMEOUT_MS, Math.min(MAX_ASK_TIMEOUT_MS, params.timeout_ms));
  }

  try {
    const reply = await askUserQuestion({
      sessionKey: context.sessionKey,
      question,
      options,
      allowFreeform,
      timeoutMs,
    });
    const answerText = reply.answer.trim();
    if (reply.optionIndex !== undefined) {
      return {
        content: `User chose option ${reply.optionIndex}: ${answerText}`,
        outputs: { answer: answerText, timed_out: false },
      };
    }
    return {
      content: `User answered: ${answerText}`,
      outputs: { answer: answerText, timed_out: false },
    };
  } catch (err: unknown) {
    const msg = formatErrorMessage(err);
    // ask-user-broker throws a specific error on timeout
    const timedOut = /time(d)? ?out/i.test(msg);
    return {
      content: msg,
      isError: true,
      outputs: { answer: "", timed_out: timedOut },
    };
  }
}

// ── batch file ops (rename / flatten / clean junk) ────────
// Ported from Cid's Python tools (.examples/tool_ideas/*).
// All share: jail, plan-then-execute, dry_run/confirm_token gating,
// skip hidden files (basename starts with "."), Unix+Windows-safe.

type RenameItem = {
  oldPath: string;     // absolute
  newPath: string;     // absolute (same dir)
  oldName: string;
  newName: string;
};

type MovePlanItem = {
  source: string;       // absolute
  destination: string;  // absolute
  relativeSource: string;
  targetName: string;
};

type DeleteItem = {
  path: string;           // absolute
  relativePath: string;
  bytes: number;
  reason: string;
};

async function walkFiles(
  root: string,
  recursive: boolean,
): Promise<Array<{ abs: string; dir: string; name: string; relPath: string }>> {
  const out: Array<{ abs: string; dir: string; name: string; relPath: string }> = [];
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden (dotfiles)
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) queue.push(abs);
      } else if (entry.isFile()) {
        const relPath = relative(root, abs);
        out.push({ abs, dir, name: entry.name, relPath });
      }
    }
  }
  return out;
}

function uniqueTargetName(
  usedNames: Set<string>,
  desired: string,
): string {
  if (!usedNames.has(desired)) {
    usedNames.add(desired);
    return desired;
  }
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let i = 1;
  while (usedNames.has(`${base}_${i}${ext}`)) i++;
  const out = `${base}_${i}${ext}`;
  usedNames.add(out);
  return out;
}

function formatRenamePlan(plan: RenameItem[]): string {
  if (plan.length === 0) return "(no changes)";
  const lines = plan.slice(0, 50).map((p) => `  ${p.oldName} → ${p.newName}`);
  if (plan.length > 50) lines.push(`  … ${plan.length - 50} more`);
  return lines.join("\n");
}

function renamePlanFingerprint(toolId: string, plan: RenameItem[]): string {
  return planFingerprint(
    toolId,
    plan.map((p) => ({ src: p.oldPath, dst: p.newPath })),
  );
}

async function executeRenamePlan(
  toolId: string,
  plan: RenameItem[],
): Promise<{ renamed: string[]; failed: Array<{ source: string; error: string }> }> {
  const renamed: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  for (const item of plan) {
    try {
      // Re-check collision right before rename (TOCTOU safety)
      try {
        await stat(item.newPath);
        failed.push({
          source: item.oldName,
          error: `target '${item.newName}' already exists`,
        });
        continue;
      } catch {
        // target doesn't exist — good
      }
      await rename(item.oldPath, item.newPath);
      renamed.push(item.newPath);
    } catch (err: unknown) {
      failed.push({ source: item.oldName, error: formatErrorMessage(err) });
    }
  }
  logger.info({ tool: toolId, renamed: renamed.length, failed: failed.length }, "batch rename complete");
  return { renamed, failed };
}

// ── rename_files_dirty ────────────────────────────────────
// Port of dirty_renamer.py. Removes brackets, normalizes separators to _,
// strips non-alphanumeric, lowercases. Keeps extension (lowercased).

function cleanDirtyFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : "";

  let clean = stem.replace(/[\[\]()\{\}]/g, "");        // remove brackets
  clean = clean.replace(/[\s.\-]+/g, "_");              // separators → _
  clean = clean.replace(/[^a-zA-Z0-9_]/g, "");          // strip non-alphanumeric
  clean = clean.replace(/^_+|_+$/g, "");                // trim leading/trailing _
  clean = clean.toLowerCase();
  return clean + ext;
}

async function handleRenameFilesDirty(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const folder = params.folder as string;
  const recursive = params.recursive === true;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!folder) return { content: "The 'folder' parameter is required.", isError: true };
  const resolved = await jailPathReal(folder);
  if (!resolved) return { content: `Folder blocked by workspace jail: '${folder}'.`, isError: true };

  const files = await walkFiles(resolved, recursive);

  // Build plan per directory to avoid cross-dir name collisions
  const plan: RenameItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const perDirUsed = new Map<string, Set<string>>();

  for (const f of files) {
    let used = perDirUsed.get(f.dir);
    if (!used) {
      // Seed with current files in dir so we don't rename into existing name
      const existing = files.filter((g) => g.dir === f.dir).map((g) => g.name);
      used = new Set(existing);
      perDirUsed.set(f.dir, used);
    }
    const cleaned = cleanDirtyFilename(f.name);
    if (cleaned === f.name) continue; // no change
    if (cleaned.length === 0) {
      skipped.push({ name: f.name, reason: "would produce empty filename" });
      continue;
    }
    // If target already exists, skip (don't auto-increment — caller can re-run)
    if (used.has(cleaned) && cleaned !== f.name) {
      skipped.push({ name: f.name, reason: `target '${cleaned}' already exists` });
      continue;
    }
    used.delete(f.name);
    used.add(cleaned);
    plan.push({
      oldPath: f.abs,
      newPath: join(f.dir, cleaned),
      oldName: f.name,
      newName: cleaned,
    });
  }

  const fingerprint = renamePlanFingerprint("rename_files_dirty", plan);
  const planText = formatRenamePlan(plan);
  const skipNote = skipped.length
    ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.name} (${s.reason})`).join(", ")}${skipped.length > 5 ? ", …" : ""}`
    : "";

  if (dryRun) {
    const token = mintConfirmToken(fingerprint);
    return {
      content: `DRY RUN — rename_files_dirty (${plan.length} file(s))\n${planText}${skipNote}\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
        skipped,
        count: 0,
        dry_run: true,
        confirm_token: token,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const token = mintConfirmToken(fingerprint);
      return {
        content:
          `Refused: rename_files_dirty of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — resend with confirm_token to execute.\n${planText}${skipNote}`,
        isError: true,
        outputs: {
          plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
          skipped,
          count: 0,
          dry_run: true,
          confirm_token: token,
        },
      };
    }
  }

  const { renamed, failed } = await executeRenamePlan("rename_files_dirty", plan);
  const summary = `Renamed ${renamed.length}/${plan.length} file(s)`;
  const errBlock = failed.length ? `\nErrors:\n${failed.map((f) => `  ✗ ${f.source}: ${f.error}`).join("\n")}` : "";
  return {
    content: `${summary}${skipNote}${errBlock}`,
    isError: failed.length > 0 && renamed.length === 0,
    outputs: {
      renamed,
      failed,
      skipped,
      count: renamed.length,
      dry_run: false,
    },
  };
}

// ── flatten_folder ────────────────────────────────────────
// Port of folder_flattener_2025_11.py (move-only; junk deletion is a
// separate tool — clean_junk_files). Walks subdirs, moves every file
// to the root folder, auto-renames on collision, removes empty dirs.

async function handleFlattenFolder(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const folder = params.folder as string;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!folder) return { content: "The 'folder' parameter is required.", isError: true };
  const resolved = await jailPathReal(folder);
  if (!resolved) return { content: `Folder blocked by workspace jail: '${folder}'.`, isError: true };

  // Collect files in subdirs only (files already in root stay put)
  const allFiles = await walkFiles(resolved, true);
  const nested = allFiles.filter((f) => f.dir !== resolved);

  // Track names that will exist in root after the plan executes,
  // seeded with current root-level contents.
  const usedNames = new Set<string>(
    allFiles.filter((f) => f.dir === resolved).map((f) => f.name),
  );

  const plan: MovePlanItem[] = [];
  for (const f of nested) {
    const target = uniqueTargetName(usedNames, f.name);
    plan.push({
      source: f.abs,
      destination: join(resolved, target),
      relativeSource: f.relPath,
      targetName: target,
    });
  }

  const fingerprint = planFingerprint(
    "flatten_folder",
    plan.map((p) => ({ src: p.source, dst: p.destination })),
  );
  const planText = plan.length === 0
    ? "(no nested files to move)"
    : plan.slice(0, 50).map((p) =>
        `  ${p.relativeSource} → ${p.targetName}${p.targetName !== basename(p.source) ? " (renamed — conflict)" : ""}`,
      ).join("\n") + (plan.length > 50 ? `\n  … ${plan.length - 50} more` : "");

  if (dryRun) {
    const token = mintConfirmToken(fingerprint);
    return {
      content: `DRY RUN — flatten_folder (${plan.length} file(s) to move)\n${planText}\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        plan: plan.map((p) => ({ source: p.relativeSource, target: p.targetName })),
        count: 0,
        dry_run: true,
        confirm_token: token,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const token = mintConfirmToken(fingerprint);
      return {
        content:
          `Refused: flatten_folder of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — resend with confirm_token to execute.\n${planText}`,
        isError: true,
        outputs: {
          plan: plan.map((p) => ({ source: p.relativeSource, target: p.targetName })),
          count: 0,
          dry_run: true,
          confirm_token: token,
        },
      };
    }
  }

  const moved: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  for (const item of plan) {
    try {
      try {
        await stat(item.destination);
        // Shouldn't happen since uniqueTargetName avoided collisions, but race-safe
        failed.push({ source: item.relativeSource, error: `destination '${item.targetName}' already exists` });
        continue;
      } catch {
        /* target free */
      }
      await rename(item.source, item.destination);
      moved.push(item.destination);
    } catch (err: unknown) {
      failed.push({ source: item.relativeSource, error: formatErrorMessage(err) });
    }
  }

  // Remove now-empty subdirectories bottom-up
  let dirsRemoved = 0;
  const subdirs = new Set<string>();
  for (const f of nested) subdirs.add(f.dir);
  // Also check any dirs between root and those subdirs
  const allDirs = [...subdirs].sort((a, b) => b.length - a.length);
  for (const d of allDirs) {
    if (d === resolved) continue;
    try {
      const entries = await readdir(d);
      if (entries.length === 0) {
        await rmdir(d);
        dirsRemoved++;
      }
    } catch {
      /* not empty or gone */
    }
  }

  const summary = `Flattened ${moved.length}/${plan.length} file(s), removed ${dirsRemoved} empty subfolder(s)`;
  const errBlock = failed.length ? `\nErrors:\n${failed.map((f) => `  ✗ ${f.source}: ${f.error}`).join("\n")}` : "";
  return {
    content: `${summary}${errBlock}`,
    isError: failed.length > 0 && moved.length === 0,
    outputs: {
      moved,
      failed,
      count: moved.length,
      dirs_removed: dirsRemoved,
      dry_run: false,
    },
  };
}

// ── clean_junk_files ──────────────────────────────────────
// Delete files matching a junk-extension list. Default list drawn
// from folder_flattener_2025_11.py's DepthCharge defaults — common
// download-cruft extensions: .nfo, .sfv, .url, .db, .ini, etc.

const DEFAULT_JUNK_EXTENSIONS = [
  ".txt", ".nfo", ".sfv", ".url", ".db", ".ini", ".ds_store",
];

async function handleCleanJunkFiles(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const folder = params.folder as string;
  const recursive = params.recursive !== false; // default true
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  const rawExts = Array.isArray(params.junk_extensions) ? params.junk_extensions : DEFAULT_JUNK_EXTENSIONS;
  const junkSet = new Set(
    rawExts
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => e.length > 0)
      .map((e) => (e.startsWith(".") ? e : "." + e)),
  );

  if (!folder) return { content: "The 'folder' parameter is required.", isError: true };
  if (junkSet.size === 0) return { content: "'junk_extensions' must contain at least one extension.", isError: true };
  const resolved = await jailPathReal(folder);
  if (!resolved) return { content: `Folder blocked by workspace jail: '${folder}'.`, isError: true };

  const files = await walkFiles(resolved, recursive);
  const plan: DeleteItem[] = [];

  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : "";
    if (!junkSet.has(ext)) continue;
    let bytes = 0;
    try {
      const s = await stat(f.abs);
      bytes = s.size;
    } catch {
      continue; // gone
    }
    plan.push({
      path: f.abs,
      relativePath: f.relPath,
      bytes,
      reason: `junk extension ${ext}`,
    });
  }

  // Fingerprint: treat as move-to-null (dst is a sentinel)
  const fingerprint = planFingerprint(
    "clean_junk_files",
    plan.map((p) => ({ src: p.path, dst: "<delete>" })),
  );
  const totalBytes = plan.reduce((s, p) => s + p.bytes, 0);
  const planText = plan.length === 0
    ? "(no junk files found)"
    : plan.slice(0, 50).map((p) => `  DEL ${p.relativePath} (${formatBytes(p.bytes)})`).join("\n") +
      (plan.length > 50 ? `\n  … ${plan.length - 50} more` : "");

  if (dryRun) {
    const token = mintConfirmToken(fingerprint);
    return {
      content: `DRY RUN — clean_junk_files (${plan.length} file(s), ${formatBytes(totalBytes)})\n${planText}\nPass dry_run:false with confirm_token to delete.`,
      outputs: {
        plan: plan.map((p) => ({ path: p.relativePath, bytes: p.bytes })),
        count: 0,
        total_bytes: totalBytes,
        dry_run: true,
        confirm_token: token,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const token = mintConfirmToken(fingerprint);
      return {
        content:
          `Refused: clean_junk_files of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — resend with confirm_token to delete.\n${planText}`,
        isError: true,
        outputs: {
          plan: plan.map((p) => ({ path: p.relativePath, bytes: p.bytes })),
          count: 0,
          total_bytes: totalBytes,
          dry_run: true,
          confirm_token: token,
        },
      };
    }
  }

  const deleted: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  let bytesFreed = 0;
  for (const item of plan) {
    try {
      if (isWriteProtected(item.path)) {
        failed.push({ source: item.relativePath, error: "write-protected path" });
        continue;
      }
      await unlink(item.path);
      deleted.push(item.path);
      bytesFreed += item.bytes;
    } catch (err: unknown) {
      failed.push({ source: item.relativePath, error: formatErrorMessage(err) });
    }
  }

  const summary = `Deleted ${deleted.length}/${plan.length} junk file(s), freed ${formatBytes(bytesFreed)}`;
  const errBlock = failed.length ? `\nErrors:\n${failed.map((f) => `  ✗ ${f.source}: ${f.error}`).join("\n")}` : "";
  return {
    content: `${summary}${errBlock}`,
    isError: failed.length > 0 && deleted.length === 0,
    outputs: {
      deleted,
      failed,
      count: deleted.length,
      bytes_freed: bytesFreed,
      dry_run: false,
    },
  };
}

// ── rename_episodes ───────────────────────────────────────
// Port of video_file_renamer_2025_12.py. Regex-based rename with an
// episode-style default (e.g. "Show - Ep5 - Title" → "Show - s01e05 - Title").
// Pads episode numbers to 2 digits when the replacement contains a
// s##e## pattern tied to group 2. Accepts any regex/replacement.

function padEpisodeGroups(replacement: string, match: RegExpMatchArray): string {
  // Apply replacement with standard back-refs first (JS semantics: $1, $2, ...)
  // Then if the output contains a sNNe<digits> pattern where the digits came
  // from a numeric capture group, zero-pad them to 2 digits.
  // Heuristic: we regex the replaced result for "s<digits>e<digits>" and pad both.
  const out = replacement.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? "");
  return out.replace(/s(\d+)e(\d+)/gi, (_, s, e) =>
    `s${String(s).padStart(2, "0")}e${String(e).padStart(2, "0")}`,
  );
}

async function handleRenameEpisodes(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const folder = params.folder as string;
  const pattern = (params.pattern as string | undefined) ?? "(.*) - Ep(\\d+) - (.*)";
  const replacement = (params.replacement as string | undefined) ?? "$1 - s01e$2 - $3";
  const recursive = params.recursive === true;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!folder) return { content: "The 'folder' parameter is required.", isError: true };
  const resolved = await jailPathReal(folder);
  if (!resolved) return { content: `Folder blocked by workspace jail: '${folder}'.`, isError: true };

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err: unknown) {
    return { content: `Invalid regex pattern: ${formatErrorMessage(err)}`, isError: true };
  }

  const files = await walkFiles(resolved, recursive);
  const plan: RenameItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const perDirUsed = new Map<string, Set<string>>();

  for (const f of files) {
    let used = perDirUsed.get(f.dir);
    if (!used) {
      const existing = files.filter((g) => g.dir === f.dir).map((g) => g.name);
      used = new Set(existing);
      perDirUsed.set(f.dir, used);
    }
    const m = f.name.match(regex);
    if (!m) {
      skipped.push({ name: f.name, reason: "no regex match" });
      continue;
    }
    const newName = padEpisodeGroups(replacement, m);
    if (newName === f.name) continue;
    if (newName.length === 0) {
      skipped.push({ name: f.name, reason: "replacement produces empty filename" });
      continue;
    }
    if (used.has(newName) && newName !== f.name) {
      skipped.push({ name: f.name, reason: `target '${newName}' already exists` });
      continue;
    }
    used.delete(f.name);
    used.add(newName);
    plan.push({
      oldPath: f.abs,
      newPath: join(f.dir, newName),
      oldName: f.name,
      newName,
    });
  }

  const fingerprint = renamePlanFingerprint("rename_episodes", plan);
  const planText = formatRenamePlan(plan);
  const skipNote = skipped.length
    ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.name} (${s.reason})`).join(", ")}${skipped.length > 5 ? ", …" : ""}`
    : "";

  if (dryRun) {
    const token = mintConfirmToken(fingerprint);
    return {
      content: `DRY RUN — rename_episodes (${plan.length} file(s))\n${planText}${skipNote}\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
        skipped,
        count: 0,
        dry_run: true,
        confirm_token: token,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const token = mintConfirmToken(fingerprint);
      return {
        content:
          `Refused: rename_episodes of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — resend with confirm_token to execute.\n${planText}${skipNote}`,
        isError: true,
        outputs: {
          plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
          skipped,
          count: 0,
          dry_run: true,
          confirm_token: token,
        },
      };
    }
  }

  const { renamed, failed } = await executeRenamePlan("rename_episodes", plan);
  const summary = `Renamed ${renamed.length}/${plan.length} file(s)`;
  const errBlock = failed.length ? `\nErrors:\n${failed.map((f) => `  ✗ ${f.source}: ${f.error}`).join("\n")}` : "";
  return {
    content: `${summary}${skipNote}${errBlock}`,
    isError: failed.length > 0 && renamed.length === 0,
    outputs: {
      renamed,
      failed,
      skipped,
      count: renamed.length,
      dry_run: false,
    },
  };
}

// ── rename_rom_files ──────────────────────────────────────
// Port of rom_renamer.py. Detects system from extension, preserves
// disc and translation tags, strips other tags, outputs the canonical
// "Title (Disc N) [X-Tr] [SYSTEM]" form. Specialized per Cid's direction.

const ROM_EXT_TO_SYSTEM: Record<string, string> = {
  ".gb": "GB", ".gbc": "GBC", ".gba": "GBA",
  ".nes": "NES", ".snes": "SNES", ".sfc": "SNES", ".smc": "SNES",
  ".vb": "NVB", ".n64": "N64", ".z64": "N64", ".v64": "N64",
  ".nds": "DS", ".3ds": "3DS",
  ".gen": "SEGA", ".md": "SEGA", ".smd": "SEGA",
  ".gg": "GG", ".sms": "SMS", ".pce": "PCE",
  ".ngp": "NGP", ".ngc": "NGP",
  ".ws": "WS", ".wsc": "WSC",
  ".a26": "2600", ".a78": "7800", ".lnx": "LYNX", ".jag": "JAG",
  ".32x": "32X", ".col": "COLECO", ".int": "INTV", ".vec": "VECTREX",
  ".cue": "PSX", ".gcm": "GCN", ".wad": "WII", ".wbfs": "WII", ".rvz": "GCN",
  ".nsp": "SWITCH", ".xci": "SWITCH", ".vpk": "VITA",
  ".pbp": "PSP", ".cso": "PSP", ".xbe": "XBOX", ".xex": "X360",
};

const ROM_TRANSLATION_PATTERNS: Array<[RegExp, string]> = [
  [/T\+Eng/, "E"], [/T-Eng/, "E"],
  [/T\+Fre/, "F"], [/T\+Fra/, "F"],
  [/T\+Spa/, "S"], [/T\+Ger/, "G"], [/T\+Deu/, "G"],
  [/T\+Ita/, "I"], [/T\+Por/, "P"], [/T\+Rus/, "R"],
  [/T\+Jpn/, "J"], [/T\+Kor/, "K"],
  [/T\+Chi/, "C"], [/T\+Zho/, "C"],
  [/T\+Swe/, "SW"], [/T\+Dut/, "D"], [/T\+Nld/, "D"],
  [/T\+Pol/, "PL"], [/T\+Fin/, "FI"],
  [/T\+Dan/, "DA"], [/T\+Nor/, "NO"],
];

function detectRomTranslationTag(filename: string): string | null {
  let m = filename.match(/\[([A-Z]{1,2})-Tr\]/);
  if (m) return `${m[1]}-Tr`;
  m = filename.match(/[\[(](?:Tr-([A-Z]{1,2}))[\])]/);
  if (m) return `${m[1]}-Tr`;
  m = filename.match(/[\[(](?:([A-Z]{1,2})-Tr)[\])]/);
  if (m) return `${m[1]}-Tr`;
  for (const [pat, code] of ROM_TRANSLATION_PATTERNS) {
    if (new RegExp("[\\[\\(]" + pat.source).test(filename)) return `${code}-Tr`;
  }
  m = filename.match(/[\[(]T\+([A-Za-z]+)/);
  if (m && m[1]) return `${m[1].slice(0, 1).toUpperCase()}-Tr`;
  return null;
}

function detectRomDiscTag(filename: string): string | null {
  const m = filename.match(/\(Disc\s*(\d+)\)/i);
  return m ? `Disc ${m[1]}` : null;
}

function computeRomNewName(filename: string, systemOverride?: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : "";

  const systemTag = systemOverride
    ? systemOverride.toUpperCase()
    : (ROM_EXT_TO_SYSTEM[ext] ?? ext.replace(/^\./, "").toUpperCase());

  const translation = detectRomTranslationTag(filename);
  const disc = detectRomDiscTag(filename);

  let clean = stem.replace(/\s*\([^)]*\)/g, "");
  clean = clean.replace(/\s*\[[^\]]*\]/g, "");
  clean = clean.trim().replace(/\s{2,}/g, " ");

  const parts = [clean];
  if (disc) parts.push(`(${disc})`);
  if (translation) parts.push(`[${translation}]`);
  parts.push(`[${systemTag}]`);

  return parts.join(" ") + ext;
}

async function handleRenameRomFiles(
  params: Record<string, unknown>,
): Promise<BuiltinResult> {
  const folder = params.folder as string;
  const recursive = params.recursive !== false; // default true — ROMs often in subfolders-per-system
  const systemOverride = typeof params.system_override === "string" ? params.system_override : undefined;
  const dryRun = params.dry_run === true;
  const confirmToken = typeof params.confirm_token === "string" ? params.confirm_token : undefined;

  if (!folder) return { content: "The 'folder' parameter is required.", isError: true };
  const resolved = await jailPathReal(folder);
  if (!resolved) return { content: `Folder blocked by workspace jail: '${folder}'.`, isError: true };

  const files = await walkFiles(resolved, recursive);
  const plan: RenameItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const perDirUsed = new Map<string, Set<string>>();

  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : "";
    // Without override, only process known ROM extensions
    if (!systemOverride && !(ext in ROM_EXT_TO_SYSTEM)) {
      skipped.push({ name: f.name, reason: "unknown ROM extension (use system_override to force)" });
      continue;
    }
    let used = perDirUsed.get(f.dir);
    if (!used) {
      const existing = files.filter((g) => g.dir === f.dir).map((g) => g.name);
      used = new Set(existing);
      perDirUsed.set(f.dir, used);
    }
    const newName = computeRomNewName(f.name, systemOverride);
    if (newName === f.name) continue;
    if (used.has(newName)) {
      skipped.push({ name: f.name, reason: `target '${newName}' already exists` });
      continue;
    }
    used.delete(f.name);
    used.add(newName);
    plan.push({
      oldPath: f.abs,
      newPath: join(f.dir, newName),
      oldName: f.name,
      newName,
    });
  }

  const fingerprint = renamePlanFingerprint("rename_rom_files", plan);
  const planText = formatRenamePlan(plan);
  const skipNote = skipped.length
    ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.name} (${s.reason})`).join(", ")}${skipped.length > 5 ? ", …" : ""}`
    : "";

  if (dryRun) {
    const token = mintConfirmToken(fingerprint);
    return {
      content: `DRY RUN — rename_rom_files (${plan.length} file(s))\n${planText}${skipNote}\nPass dry_run:false with confirm_token to execute.`,
      outputs: {
        plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
        skipped,
        count: 0,
        dry_run: true,
        confirm_token: token,
      },
    };
  }

  if (plan.length > dryRunBulkThreshold) {
    if (!confirmToken || !consumeConfirmToken(confirmToken, fingerprint)) {
      const token = mintConfirmToken(fingerprint);
      return {
        content:
          `Refused: rename_rom_files of ${plan.length} files exceeds the bulk threshold (${dryRunBulkThreshold}). ` +
          `Preview below — resend with confirm_token to execute.\n${planText}${skipNote}`,
        isError: true,
        outputs: {
          plan: plan.map((p) => ({ old: p.oldName, new: p.newName, path: p.oldPath })),
          skipped,
          count: 0,
          dry_run: true,
          confirm_token: token,
        },
      };
    }
  }

  const { renamed, failed } = await executeRenamePlan("rename_rom_files", plan);
  const summary = `Renamed ${renamed.length}/${plan.length} ROM file(s)`;
  const errBlock = failed.length ? `\nErrors:\n${failed.map((f) => `  ✗ ${f.source}: ${f.error}`).join("\n")}` : "";
  return {
    content: `${summary}${skipNote}${errBlock}`,
    isError: failed.length > 0 && renamed.length === 0,
    outputs: {
      renamed,
      failed,
      skipped,
      count: renamed.length,
      dry_run: false,
    },
  };
}

// ── Registration ──────────────────────────────────────────

/**
 * Register all built-in tool handlers.
 * Call this once during pipeline initialization.
 */
export function registerBuiltinTools(config?: {
  fileAccessPaths?: string[];
  killUrlBase?: string;
}): void {
  if (config?.fileAccessPaths?.length) {
    setFileAccessPaths(config.fileAccessPaths);
  }
  if (typeof config?.killUrlBase === "string") {
    setKillUrlBase(config.killUrlBase);
  }

  registerToolHandler("file_read", handleFileRead);
  registerToolHandler("file_write", handleFileWrite);
  registerToolHandler("file_edit", handleFileEdit);
  registerToolHandler("file_move", handleFileMove);
  registerToolHandler("file_copy", handleFileCopy);
  registerToolHandler("file_list", handleFileList);
  registerToolHandler("glob_search", handleGlobSearch);
  registerToolHandler("grep_search", handleGrepSearch);
  registerToolHandler("shell", handleShell);
  registerToolHandler("web_fetch", handleWebFetch);
  registerToolHandler("weather", handleWeather);
  registerToolHandler("memory_write", handleMemoryWrite);
  registerToolHandler("memory_read", handleMemoryRead);
  registerToolHandler("timer", handleTimer);
  registerToolHandler("random", handleRandom);
  registerToolHandler("ask_user", handleAskUser);

  // Agent data system tools (identity, notes, user profile)
  registerAgentDataTools();

  // Scheduler tools (schedule_task, list_schedules, cancel_schedule)
  registerSchedulerTools();

  // In-session planning scratchpad (todo_write)
  registerTodoTools();

  // Outbound messaging (message_send — external channels + CLI mirror)
  registerMessageSendTool();

  // Web search (Tavily / Brave / DuckDuckGo fallback)
  registerWebSearchTool();

  // Budgeted child inference (subagent_spawn). The runtime itself is
  // bound later by inference.ts via setSubagentRuntime() — this only
  // wires the handler shell.
  registerSubagentSpawnTool();

  // Phase 1 plan mode (enter/exit/status). Gating for write/exec/network
  // while a session is in plan mode is enforced in inference.processToolCalls.
  registerPlanModeTool();

  // Email attachment staging — agent calls this during an inbound turn
  // to queue files that ride along with the next reply. Drained by the
  // gateway handler closure after the inference loop.
  registerEmailAttachTool();

  // PDF extraction (read — pdfjs-dist, text + normalization passes)
  registerPdfExtractTool();

  // Batch file ops (ported from Cid's Python tools)
  registerToolHandler("rename_files_dirty", handleRenameFilesDirty);
  registerToolHandler("flatten_folder", handleFlattenFolder);
  registerToolHandler("clean_junk_files", handleCleanJunkFiles);
  registerToolHandler("rename_episodes", handleRenameEpisodes);
  registerToolHandler("rename_rom_files", handleRenameRomFiles);

  // ── Prompt fragments for builtins ────────────────────────
  // Rules for the tools defined in this file register here so that when
  // a tool is removed from an agent's toolset, its rule drops out too.

  registerPromptFragment({
    id: "tool:timer",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("timer"),
    order: 70,
    content: [
      "TIMERS: Use the 'timer' tool to measure real elapsed time. Actions:",
      "start (begin timing), check (see elapsed), stop (end and report), list",
      "(show all running timers). The timer uses the OS monotonic clock — it",
      "measures REAL wall-clock time, not estimates. When a user asks you to",
      "time something, ALWAYS use this tool. Never estimate or guess elapsed time.",
    ].join("\n"),
  });

  registerPromptFragment({
    id: "tool:random",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("random"),
    order: 71,
    content: [
      "RANDOM NUMBERS: Use the 'random' tool for ANY request involving",
      "randomness. Modes: integer (pick a number in a range), float (0-1),",
      "uuid, choice (pick from a list), dice (roll NdM). This uses real",
      "cryptographic entropy from the OS — never try to pick random numbers",
      "yourself, you WILL be biased. Always use the tool.",
    ].join("\n"),
  });

  registerPromptFragment({
    id: "tool:shell",
    category: "tool",
    // Shell rules are Windows-specific; register only when shell is in
    // the toolset AND we're on Windows. On other platforms the rules
    // would be actively wrong (Unix pipes, bash, etc.).
    predicate: (ctx) => ctx.tools.includes("shell") && platform() === "win32",
    order: 72,
    content: [
      "WINDOWS SHELL: You are running on Windows. The 'shell' tool spawns",
      "cmd.exe, NOT bash. This means:",
      "- Use 'dir' not 'ls', 'type' not 'cat', 'findstr' not 'grep', 'where' not 'which'.",
      "- Do NOT use single quotes — cmd.exe does not understand them. Use double quotes only.",
      "- Do NOT use Unix pipes like '2>&1 | tee' — use '>' and '2>' separately or run PowerShell via 'powershell -c \"...\"'.",
      "- Do NOT chain with '&&' or '||' at the top level — cmd.exe uses '&' for sequential. Prefer running one command at a time.",
      "- For complex operations, prefer the built-in tools (grep_search, file_list, file_read, glob_search) over shell — they're faster, cross-platform, and don't have quoting issues. Only use shell for things that genuinely need a program (npm, git, vitest, etc.).",
      "- If a shell command fails with 'not recognized as an internal or external command', STOP and switch to a built-in tool or use the correct Windows equivalent. Do not retry the same Unix command.",
      "For moving, copying, or renaming files, ALWAYS use file_move or file_copy instead of shell commands. The shell tool has issues with special characters and spaces in file paths on Windows.",
    ].join("\n"),
  });

  registerPromptFragment({
    id: "tool:file-paths",
    category: "tool",
    // Applies whenever any file-cluster tool is in play. The path rules
    // are generated from the actual configured access roots so docs and
    // prompt never drift into hardcoded local-user paths.
    predicate: (ctx) =>
      ctx.tools.includes("file_read") ||
      ctx.tools.includes("file_write") ||
      ctx.tools.includes("file_edit") ||
      ctx.tools.includes("file_move") ||
      ctx.tools.includes("file_copy") ||
      ctx.tools.includes("file_list") ||
      ctx.tools.includes("glob_search"),
    order: 73,
    content: [
      "FILE PATHS: File paths you can access:",
      formatAllowedRootsForPrompt(),
      "When using shell outside the workspace, pass the shell tool's cwd parameter",
      "with one of the allowed directories. Do not cd into paths outside this list.",
    ].join("\n"),
  });

  logger.info(
    {
      tools: ["file_read", "file_write", "file_edit", "file_move", "file_copy", "file_list", "glob_search", "grep_search", "shell", "web_fetch", "weather", "pdf_extract", "web_search", "memory_write", "memory_read", "timer", "random", "ask_user", "todo_write", "message_send", "subagent_spawn", "plan_mode", "email_attach", "email_attach_content", "rename_files_dirty", "flatten_folder", "clean_junk_files", "rename_episodes", "rename_rom_files"],
      extraAllowedPaths,
    },
    "Built-in tool handlers registered",
  );
}
