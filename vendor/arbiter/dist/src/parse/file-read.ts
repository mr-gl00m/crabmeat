import { jailPath, looksFileLike } from "./path-jail.js";
import { trimTerminalPunct } from "./trim.js";
import type { EffectClass, IntentAction } from "../types.js";

const FILE_READ_RE =
  /\b(?:read|open|load|show|cat)\s+(?:the\s+)?(?:contents?\s+of\s+)?(\S+)/i;

export interface FileReadParse {
  readonly action: Extract<IntentAction, "file_read">;
  readonly effectClass: Extract<EffectClass, "read">;
  readonly params: {
    readonly filename: string;
    readonly absolutePath: string;
  };
}

export function parseFileRead(
  text: string,
  workspace: string,
): FileReadParse | null {
  const m = FILE_READ_RE.exec(text);
  if (m === null) return null;
  const target = trimTerminalPunct(m[1] ?? "");
  if (target.length === 0) return null;
  if (!looksFileLike(target)) return null;

  const jailed = jailPath(target, workspace);
  if (!jailed.ok || jailed.path === undefined) return null;

  return {
    action: "file_read",
    effectClass: "read",
    params: {
      filename: target,
      absolutePath: jailed.path,
    },
  };
}
