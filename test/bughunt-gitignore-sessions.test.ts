// Regression test for BH-2026-05-10-001 (bug-hunt 2026-05-10).
// Invariant: source files committed under crabmeat/src/ MUST be tracked
// by git so a fresh clone has working code. The .gitignore lists
// `sessions/` as a runtime data directory, but the original pattern was
// unanchored — git applied it to ANY directory named "sessions/",
// including the source-code tree at crabmeat/src/sessions/.
// Fix: anchor pattern to `/sessions/` so it only matches the root-level
// runtime dir. This test asserts the source tree stays tracked.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("BH-2026-05-10-001: .gitignore must not swallow source-code dirs", () => {
  it("crabmeat/src/sessions/store.ts is not ignored by git", () => {
    // Run from the repo root (parent of crabmeat/) so paths resolve.
    const repoRoot = resolve(__dirname, "..", "..");
    let output = "";
    let exitCode = 0;
    try {
      output = execFileSync(
        "git",
        ["check-ignore", "-v", "crabmeat/src/sessions/store.ts"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      // Exit 1 = path NOT ignored (the desired outcome).
      // Exit 0 = path IS ignored.
      const e = err as { status?: number; stdout?: string };
      exitCode = e.status ?? -1;
      output = e.stdout ?? "";
    }
    expect(
      exitCode,
      `git check-ignore returned ${exitCode} with output:\n${output}\n` +
        "Expected exit code 1 (path not ignored). Exit 0 means git is excluding " +
        "the source file from tracking — fresh clones won't have the sessions/ module.",
    ).toBe(1);
  });
});
