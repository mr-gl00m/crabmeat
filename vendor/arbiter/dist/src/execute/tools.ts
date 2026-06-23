import { readFile, stat } from "node:fs/promises";
import { atomicWriteText } from "../io/atomic.js";
import { jailPath, verifyJailedPath } from "../parse/path-jail.js";
import type { Result } from "../types.js";

// RT-2026-04-30-004 — cap file_read at a fixed size to bound memory cost. A
// 2 MiB ceiling matches the consult cap; consumers that need more must change
// this constant deliberately rather than discover it via OOM.
export const DEFAULT_MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

export async function execFileWrite(
  args: Record<string, unknown>,
  workspace: string,
): Promise<Result> {
  const filename = String(args["filename"] ?? "");
  const content = String(args["content"] ?? "");
  if (filename.length === 0) {
    return { ok: false, error: "filename missing" };
  }
  const jailed = jailPath(filename, workspace);
  if (!jailed.ok || jailed.path === undefined) {
    return { ok: false, error: `path-jail rejected: ${jailed.reason ?? "unknown"}` };
  }
  // RT-2026-04-30-006 — realpath check on the resolved target (or its parent
  // if the file does not yet exist) so a symlink inside the workspace cannot
  // smuggle the write outside.
  const verified = await verifyJailedPath(jailed.path, workspace);
  if (!verified.ok || verified.path === undefined) {
    return { ok: false, error: `path-jail rejected: ${verified.reason ?? "unknown"}` };
  }
  await atomicWriteText(verified.path, content);
  return {
    ok: true,
    output: { writtenTo: verified.path, bytes: Buffer.byteLength(content) },
  };
}

export async function execFileRead(
  args: Record<string, unknown>,
  workspace: string,
  maxBytes: number = DEFAULT_MAX_FILE_READ_BYTES,
): Promise<Result> {
  const filename = String(args["filename"] ?? "");
  if (filename.length === 0) {
    return { ok: false, error: "filename missing" };
  }
  const jailed = jailPath(filename, workspace);
  if (!jailed.ok || jailed.path === undefined) {
    return { ok: false, error: `path-jail rejected: ${jailed.reason ?? "unknown"}` };
  }
  const verified = await verifyJailedPath(jailed.path, workspace);
  if (!verified.ok || verified.path === undefined) {
    return { ok: false, error: `path-jail rejected: ${verified.reason ?? "unknown"}` };
  }
  try {
    const st = await stat(verified.path);
    if (st.size > maxBytes) {
      return {
        ok: false,
        error: `file_read max size exceeded (${st.size} > ${maxBytes} bytes)`,
      };
    }
    const content = await readFile(verified.path, "utf-8");
    return { ok: true, output: { readFrom: verified.path, content } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function execWebSearch(args: Record<string, unknown>): Result {
  const query = String(args["query"] ?? "");
  if (query.length === 0) return { ok: false, error: "query missing" };
  return {
    ok: true,
    output: {
      query,
      note: "v0.1.0 returns query echo; real search backend is post-v0.1.0 work",
    },
  };
}
