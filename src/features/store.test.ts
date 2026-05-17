/**
 * File-based feature toggle store tests (Phase 4.19 B2).
 *
 * Exercises the read/write/clear/list lifecycle using an isolated
 * tmpdir as the features root. Atomic-write discipline + invalid-name
 * rejection + corrupt-file fallback are the load-bearing properties.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFeature,
  writeFeature,
  clearFeature,
  listFeatures,
  isFeatureEngaged,
  setFeaturesRoot,
} from "./store.js";
import { isValidFeatureName, KNOWN_FEATURES } from "./types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crabmeat-features-"));
  setFeaturesRoot(tmp);
});

afterEach(() => {
  setFeaturesRoot(undefined);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("isValidFeatureName", () => {
  it("accepts the known feature names", () => {
    for (const name of KNOWN_FEATURES) {
      expect(isValidFeatureName(name)).toBe(true);
    }
  });

  it("rejects empty / whitespace / overlong names", () => {
    expect(isValidFeatureName("")).toBe(false);
    expect(isValidFeatureName("   ")).toBe(false);
    expect(isValidFeatureName("a".repeat(65))).toBe(false);
  });

  it("rejects path-traversal-shaped names", () => {
    expect(isValidFeatureName("../escape")).toBe(false);
    expect(isValidFeatureName(".hidden")).toBe(false);
    expect(isValidFeatureName("with/slash")).toBe(false);
    expect(isValidFeatureName("with\\backslash")).toBe(false);
  });

  it("rejects names that don't start with a letter", () => {
    expect(isValidFeatureName("1pause")).toBe(false);
    expect(isValidFeatureName("-pause")).toBe(false);
  });

  it("rejects uppercase + underscores (filesystem-portability)", () => {
    expect(isValidFeatureName("Pause")).toBe(false);
    expect(isValidFeatureName("pause_long")).toBe(false);
  });
});

describe("readFeature / writeFeature lifecycle", () => {
  it("returns null when no toggle file exists", async () => {
    expect(await readFeature("pause")).toBeNull();
    expect(await isFeatureEngaged("pause")).toBe(false);
  });

  it("round-trips a write + read", async () => {
    await writeFeature("pause", { enabled: true, reason: "migration", set_by: "cli" });
    const flag = await readFeature("pause");
    expect(flag).not.toBeNull();
    expect(flag?.enabled).toBe(true);
    expect(flag?.reason).toBe("migration");
    expect(flag?.set_by).toBe("cli");
    expect(typeof flag?.set_at).toBe("string");
    // Reasonable ISO-8601 shape, not a stale or future stamp.
    const written = new Date(flag!.set_at).getTime();
    expect(written).toBeGreaterThan(Date.now() - 5_000);
    expect(written).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("isFeatureEngaged reflects the most recent write", async () => {
    await writeFeature("web-fetch", { enabled: true, set_by: "cli" });
    expect(await isFeatureEngaged("web-fetch")).toBe(true);

    await writeFeature("web-fetch", { enabled: false, set_by: "cli" });
    expect(await isFeatureEngaged("web-fetch")).toBe(false);
  });

  it("write rejects an invalid feature name", async () => {
    await expect(
      writeFeature("../escape", { enabled: true, set_by: "cli" }),
    ).rejects.toThrow(/Invalid feature name/);
  });

  it("treats a malformed JSON file as absent (no false enable)", async () => {
    writeFileSync(join(tmp, "pause.json"), "{ this is not json", "utf-8");
    expect(await readFeature("pause")).toBeNull();
    expect(await isFeatureEngaged("pause")).toBe(false);
  });

  it("treats a JSON file with the wrong shape as absent", async () => {
    writeFileSync(
      join(tmp, "pause.json"),
      JSON.stringify({ enabled: "yes please" }),
      "utf-8",
    );
    expect(await readFeature("pause")).toBeNull();
  });

  it("write is atomic (no .tmp file remains on success)", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(tmp);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
    expect(entries).toContain("pause.json");
  });

  it("clearFeature removes the file (idempotent)", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    expect(existsSync(join(tmp, "pause.json"))).toBe(true);

    await clearFeature("pause");
    expect(existsSync(join(tmp, "pause.json"))).toBe(false);
    // Idempotent: clearing an already-gone file does not throw.
    await clearFeature("pause");
  });

  it("preserves the optional reason field through round-trip", async () => {
    await writeFeature("escalation", { enabled: true, reason: "noisy provider", set_by: "auto" });
    const flag = await readFeature("escalation");
    expect(flag?.reason).toBe("noisy provider");
  });

  it("omits the reason field when not provided on write", async () => {
    await writeFeature("escalation", { enabled: true, set_by: "cli" });
    const flag = await readFeature("escalation");
    expect(flag?.reason).toBeUndefined();
  });
});

describe("listFeatures", () => {
  it("returns empty when no features directory exists", async () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(await listFeatures()).toEqual([]);
  });

  it("lists every present + valid toggle", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    await writeFeature("web-fetch", { enabled: false, set_by: "auto" });
    await writeFeature("escalation", { enabled: true, reason: "test", set_by: "cli" });

    const entries = await listFeatures();
    expect(entries.map((e) => e.name).sort()).toEqual(["escalation", "pause", "web-fetch"]);
    const escalation = entries.find((e) => e.name === "escalation");
    expect(escalation?.flag.reason).toBe("test");
  });

  it("ignores files with invalid names or non-json files", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    writeFileSync(join(tmp, "Invalid.json"), JSON.stringify({}), "utf-8");
    writeFileSync(join(tmp, "valid-name.txt"), "data", "utf-8");
    writeFileSync(join(tmp, ".hidden.json"), JSON.stringify({}), "utf-8");

    const entries = await listFeatures();
    expect(entries.map((e) => e.name)).toEqual(["pause"]);
  });
});
