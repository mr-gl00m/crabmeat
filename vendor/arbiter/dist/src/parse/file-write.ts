import { jailPath, looksFileLike } from "./path-jail.js";
import { trimTerminalPunct } from "./trim.js";
import type { EffectClass, IntentAction } from "../types.js";

const FILE_WRITE_RE =
  /\b(?:write|save|create|put|store)\s+(?:me\s+|us\s+|out\s+)?(.+?)\s+(?:to|into|at|in)\s+(\S+)/i;

export interface FileWriteParse {
  readonly action: Extract<IntentAction, "file_write">;
  readonly effectClass: Extract<EffectClass, "write">;
  readonly params: {
    readonly filename: string;
    readonly absolutePath: string;
    readonly contentNeeded: string;
  };
}

export function parseFileWrite(
  text: string,
  workspace: string,
): FileWriteParse | null {
  const m = FILE_WRITE_RE.exec(text);
  if (m === null) return null;
  const contentNeeded = m[1]?.trim() ?? "";
  const destination = trimTerminalPunct(m[2] ?? "");
  if (contentNeeded.length === 0 || destination.length === 0) return null;
  if (!looksFileLike(destination)) return null;

  const jailed = jailPath(destination, workspace);
  if (!jailed.ok || jailed.path === undefined) return null;

  return {
    action: "file_write",
    effectClass: "write",
    params: {
      filename: destination,
      absolutePath: jailed.path,
      contentNeeded,
    },
  };
}
