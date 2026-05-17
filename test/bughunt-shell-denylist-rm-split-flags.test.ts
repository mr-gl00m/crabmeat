// Regression test for BH-2026-05-10-004 (bug-hunt 2026-05-10).
// Invariant: SHELL_DENYLIST[0] must block `rm` against root-targeted
// paths regardless of flag arrangement. The original regex required a
// single optional flag block adjacent to the path; split flags
// (`rm -f -r /`), long flags (`rm --recursive --force /`), and prefix
// flags (`rm --no-preserve-root -rf /`) all bypassed.
// Fix: expand to `(?:-{1,2}\S+\s+)*` so any number of short or long
// flag tokens between `rm` and the path are absorbed.
import { describe, it, expect, beforeAll } from "vitest";
import {
  registerBuiltinTools,
  setWorkspaceRoot,
} from "../src/agents/tools/builtins.js";
import { getToolHandler } from "../src/agents/tools/handlers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BH-2026-05-10-004: shell denylist bypass via split flags", () => {
  beforeAll(() => {
    const ws = mkdtempSync(join(tmpdir(), "bh-shell-jail-"));
    setWorkspaceRoot(ws);
    registerBuiltinTools({});
  });

  const BYPASSING_INPUTS: ReadonlyArray<{ label: string; command: string }> = [
    { label: "split flags", command: "rm -f -r /home/victim" },
    { label: "long flag preceding short", command: "rm --no-preserve-root -rf /" },
    { label: "long flags only", command: "rm --recursive --force /etc" },
  ];

  for (const { label, command } of BYPASSING_INPUTS) {
    it(`(${label}) "${command}" must be denied at validation`, async () => {
      const shell = getToolHandler("shell");
      const result = await shell({ command, dry_run: true });
      expect(
        result.isError,
        `Bypass: command "${command}" was NOT blocked by SHELL_DENYLIST. ` +
          `Result: ${JSON.stringify({ isError: result.isError, head: result.content.slice(0, 80) })}`,
      ).toBe(true);
      expect(result.content).toMatch(/denied by security policy/i);
    });
  }
});
