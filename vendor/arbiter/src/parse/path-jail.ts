import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize as nodeNormalize, resolve, sep } from "node:path";

export interface PathJailResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly path?: string;
}

const FILE_EXT = /\.[a-zA-Z0-9]{1,8}$/;

/**
 * Cheap "does this look like a filename?" check used by the file_read
 * and file_write parsers to reject extracted destinations that are
 * obviously not paths (e.g. parsed verb-object instead of object-path).
 * Treats anything with an extension or a path separator as file-like.
 */
export function looksFileLike(s: string): boolean {
  return FILE_EXT.test(s) || s.includes("/") || s.includes("\\");
}

/**
 * Cheap "does this look like a path-injection attempt embedded in a
 * search query / topic?" check. Used by web-search and news-search
 * parsers to reject queries that smuggle traversal or absolute-path
 * tokens — those would never be legitimate search topics, but they're
 * a classic prompt-injection vector where the attacker hopes the
 * downstream backend interprets the topic as a file path.
 *
 * Distinct from jailPath: jailPath is for *parsed file destinations*
 * that we intend to resolve against a workspace. This one is for
 * *opaque text* (a search query, a topic name) where any path-shaped
 * fragment is suspicious by definition.
 */
export function looksLikePathInjection(s: string): boolean {
  return s.includes("/") || s.includes("\\") || s.includes("..");
}

const SYSTEM_ROOTS = [
  "/etc",
  "/root",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
];

// RT-2026-04-30-007 — defense-in-depth refusal. The consuming project
// (CrabMeat) currently passes process.cwd() as the workspace; if that
// resolves to $HOME, every dotfile and SSH key falls inside the jail. A
// library-level guard catches the misconfiguration regardless of consumer.
const SYSTEM_ROOT_PREFIXES = [
  "/etc/",
  "/root/",
  "/var/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/proc/",
  "/sys/",
  "/dev/",
  "/boot/",
];

export function isUnsafeWorkspace(workspace: string): {
  unsafe: boolean;
  reason?: string;
} {
  const resolved = resolve(workspace);
  const home = resolve(homedir());
  if (resolved === home) {
    return { unsafe: true, reason: "workspace equals homedir" };
  }
  if (resolved === sep || resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
    return { unsafe: true, reason: "workspace is filesystem root" };
  }
  const lower = resolved.replaceAll("\\", "/").toLowerCase() + "/";
  for (const prefix of SYSTEM_ROOT_PREFIXES) {
    if (lower.startsWith(prefix) || lower === prefix) {
      return { unsafe: true, reason: `workspace under ${prefix.replace(/\/$/, "")}` };
    }
  }
  return { unsafe: false };
}

function looksAbsolute(raw: string): boolean {
  if (isAbsolute(raw)) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith("\\\\")) return true;
  return false;
}

function withinWorkspace(absolute: string, workspace: string): boolean {
  const root = resolve(workspace) + sep;
  const target = absolute + (absolute.endsWith(sep) ? "" : sep);
  return target.startsWith(root) || absolute === resolve(workspace);
}

export function jailPath(raw: string, workspace: string): PathJailResult {
  if (raw.length === 0) {
    return { ok: false, reason: "empty path" };
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "null byte in path" };
  }

  const collapsed = nodeNormalize(raw);

  if (collapsed.includes("..")) {
    return { ok: false, reason: "path traversal" };
  }

  if (looksAbsolute(raw)) {
    for (const root of SYSTEM_ROOTS) {
      const lower = raw.toLowerCase().replaceAll("\\", "/");
      if (lower.startsWith(root + "/") || lower === root) {
        return { ok: false, reason: "system path" };
      }
    }
    return { ok: false, reason: "absolute path outside workspace" };
  }

  const absolute = resolve(workspace, collapsed);
  if (!withinWorkspace(absolute, workspace)) {
    return { ok: false, reason: "escapes workspace" };
  }

  return { ok: true, path: absolute };
}

// RT-2026-04-30-006 — the lexical jail above does not follow symlinks. A
// reparse point inside the workspace pointing outside would otherwise let a
// later read/write break out. This helper resolves the realpath (or the
// parent's realpath, when the target is a not-yet-existing file) and verifies
// it still sits inside realpath(workspace). Async because realpath is.
export async function verifyJailedPath(
  jailedAbsolute: string,
  workspace: string,
): Promise<PathJailResult> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(workspace);
  } catch {
    return { ok: false, reason: "workspace realpath failed" };
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(jailedAbsolute);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      return { ok: false, reason: `realpath failed: ${code ?? "unknown"}` };
    }
    // Target does not exist (legitimate for file_write). Realpath the parent
    // and append the basename; the parent must exist OR also climb until we
    // find an existing ancestor. Climb once is enough in practice.
    let parent = dirname(jailedAbsolute);
    let parentReal: string | null = null;
    for (let i = 0; i < 32; i++) {
      try {
        parentReal = await fs.realpath(parent);
        break;
      } catch {
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    if (parentReal === null) {
      return { ok: false, reason: "no existing ancestor for target" };
    }
    realTarget = parentReal + jailedAbsolute.slice(parent.length);
  }
  const rootWithSep = realRoot + (realRoot.endsWith(sep) ? "" : sep);
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    return { ok: false, reason: "realpath escapes workspace (symlink)" };
  }
  return { ok: true, path: realTarget };
}
