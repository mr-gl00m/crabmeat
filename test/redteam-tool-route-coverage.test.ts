/**
 * RT-TOOL-ROUTE coverage audit (Phase 4.19 A3).
 *
 * The capability-ID + effect-class gate (`validateToolInvocation` →
 * `executeValidatedTool`) is the ONLY sanctioned route for tool
 * execution. Any source file that pulls a handler out of the registry
 * and calls it directly bypasses the gate, which is the failure
 * Gator's audit caught (two parallel tool routes).
 *
 * This test enumerates every non-test source file that imports
 * `getToolHandler` from `./tools/handlers.js` and asserts the importer
 * is on the allowlist of legitimate call-sites. Adding a new caller
 * is a deliberate decision that should fail the test until the
 * allowlist is updated; that's the whole point.
 *
 * Allowlist:
 *   - src/agents/inference.ts — canonical executor, wraps the call in
 *     `executeValidatedTool` (verified separately below).
 *   - src/agents/tools/handlers.ts — defines the function itself.
 *   - src/commands/doctor.ts — read-only `hasToolHandler` check (does
 *     not invoke the handler), allowed.
 *
 * The corresponding negative assertion: every tool in the registered
 * catalog has its handler reachable through the `executeValidatedTool`
 * path. We can't easily prove that statically, but the inference.ts
 * code path is locked by the assertion that the only caller of
 * `getToolHandler` outside the allowlist would be a test or a
 * deliberate addition.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative } from "node:path";
import { globSync } from "tinyglobby";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");

// Canonical importers of getToolHandler / hasToolHandler.
// New entries here require a justification comment.
const IMPORT_ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: "src/agents/tools/handlers.ts",
    reason: "Defines the function itself (registry module).",
  },
  {
    file: "src/agents/inference.ts",
    reason:
      "Canonical tool-execution path. Calls getToolHandler, then wraps in " +
      "executeValidatedTool which enforces the capability-ID + effect-class gate.",
  },
  {
    file: "src/commands/doctor.ts",
    reason:
      "Read-only diagnostic: hasToolHandler check during config validation. " +
      "Does NOT invoke the handler.",
  },
];

function normalizeForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("RT-TOOL-ROUTE A3: getToolHandler/hasToolHandler import coverage", () => {
  it("only allowlisted source files import the EXECUTE-side helpers (getToolHandler / hasToolHandler) from tools/handlers.js", () => {
    // Distinguish two import shapes:
    //   - REGISTER side: `registerToolHandler` — every tool implementation
    //     pulls this in to register its handler at startup. Not a
    //     bypass risk; left unrestricted.
    //   - EXECUTE side: `getToolHandler` (resolves the handler for
    //     invocation) and `hasToolHandler` (presence check). These ARE
    //     the bypass risk because anything that resolves the handler
    //     can also call it directly without executeValidatedTool.
    const sources = globSync("**/*.ts", {
      cwd: SRC_ROOT,
      absolute: true,
      ignore: ["**/*.test.ts", "**/*.d.ts"],
    });

    const executeImporters: string[] = [];
    const importLine =
      /import\s*\{([^}]*)\}\s*from\s*["'](?:[^"']*\/tools\/handlers\.js|\.\/handlers\.js)["']/g;
    const EXECUTE_NAMES = new Set(["getToolHandler", "hasToolHandler"]);

    for (const abs of sources) {
      const text = readFileSync(abs, "utf-8");
      const isInToolsDir = normalizeForwardSlash(abs).includes("/agents/tools/");
      let m: RegExpExecArray | null;
      while ((m = importLine.exec(text)) !== null) {
        // Only count `./handlers.js` if the file is actually in the
        // tools dir (avoid same-name false positives from other dirs).
        const matched = text.slice(m.index, m.index + m[0].length);
        if (matched.includes("./handlers.js") && !isInToolsDir) continue;

        const named = m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
        const hasExecuteImport = named.some((n) => EXECUTE_NAMES.has(n));
        if (hasExecuteImport) {
          const rel = normalizeForwardSlash(relative(REPO_ROOT, abs));
          executeImporters.push(rel);
        }
      }
    }

    const allowedSet = new Set(IMPORT_ALLOWLIST.map((e) => e.file));
    const unauthorized = executeImporters.filter((f) => !allowedSet.has(f));

    expect(
      unauthorized,
      `Found unauthorized importers of getToolHandler/hasToolHandler — these ` +
        `are potential tool-execution routes that bypass executeValidatedTool. ` +
        `New importers must be added to IMPORT_ALLOWLIST in this test file ` +
        `with a comment justifying the call site. Bypass route candidates: ${unauthorized.join(", ")}`,
    ).toEqual([]);
  });

  it("the canonical tool-execution call site (inference.ts) wraps getToolHandler in executeValidatedTool", () => {
    const inferencePath = resolve(SRC_ROOT, "agents/inference.ts");
    const text = readFileSync(inferencePath, "utf-8");

    // The two adjacent calls — handler resolution + executeValidatedTool —
    // are the load-bearing pair. If a future refactor splits these or
    // drops the executeValidatedTool wrap, this assertion fails.
    expect(text).toMatch(/getToolHandler\(\s*validated\.toolId\s*\)/);
    expect(text).toMatch(/executeValidatedTool\s*\(/);

    // Sanity: getToolHandler appears only ONCE in inference.ts. Multiple
    // call sites would mean parallel execution paths inside the same file.
    const matches = text.match(/getToolHandler\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("registry's bare registry.get() is only used inside the tools/ module (not as an external execute path)", () => {
    // A second bypass shape: a file outside src/agents/tools/ imports
    // the raw `registry` Map and calls `registry.get(toolId)(params)`.
    // The registry is private to handlers.ts (no export of `registry`),
    // but a future refactor could export it. Catch that statically.
    const sources = globSync("**/*.ts", {
      cwd: SRC_ROOT,
      absolute: true,
      ignore: ["**/*.test.ts", "**/*.d.ts"],
    });
    for (const abs of sources) {
      const text = readFileSync(abs, "utf-8");
      // The handlers.ts file legitimately exports the registry map for
      // catalog.ts to read tool metadata. We allow `registry.get(` only
      // in files inside agents/tools/.
      const isInToolsDir = normalizeForwardSlash(abs).includes("/agents/tools/");
      if (isInToolsDir) continue;
      expect(
        text.match(/\bregistry\.get\(/),
        `${abs} reads from the tool registry directly. Tool execution must ` +
          `route through executeValidatedTool, not raw registry access.`,
      ).toBeNull();
    }
  });
});
