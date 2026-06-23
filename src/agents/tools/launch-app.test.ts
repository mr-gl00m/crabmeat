import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerLaunchAppTool,
  setLaunchAppDeps,
  _resetLaunchAppCacheForTests,
  type InstalledApp,
  type LaunchAppDeps,
} from "./launch-app.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";

let stateDir: string;
let originalDeps: LaunchAppDeps;
let launched: InstalledApp[];
let scanCalls: number;
let installedApps: InstalledApp[];
let fakeNow: number;

const APPS: InstalledApp[] = [
  { name: "Google Chrome", appId: "Chrome" },
  { name: "Google Drive", appId: "GoogleDriveFS" },
  { name: "Calculator", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "Notepad", appId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
  { name: "Steam", appId: "Valve.Steam" },
];

beforeAll(() => {
  registerLaunchAppTool();
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "crabmeat-launchapp-"));
  launched = [];
  scanCalls = 0;
  installedApps = [...APPS];
  fakeNow = 1_000_000_000_000;
  _resetLaunchAppCacheForTests();
  originalDeps = setLaunchAppDeps({
    stateDir,
    platform: () => "win32",
    now: () => fakeNow,
    scanApps: async () => {
      scanCalls++;
      return installedApps;
    },
    spawnApp: async (app) => {
      launched.push(app);
    },
  });
});

afterEach(() => {
  setLaunchAppDeps(originalDeps);
  rmSync(stateDir, { recursive: true, force: true });
});

function aliasFile(): string {
  return join(stateDir, "app-aliases.json");
}

describe("launch_app tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("launch_app")).toBe(true);
  });

  it("requires a name", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(launched).toHaveLength(0);
  });

  it("refuses honestly on non-Windows platforms", async () => {
    setLaunchAppDeps({ platform: () => "linux" });
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("only implemented on Windows");
    expect(launched).toHaveLength(0);
  });

  it("launches on an exact name match", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Launch dispatched: 'Calculator'");
    expect(launched).toHaveLength(1);
    expect(launched[0]!.appId).toContain("WindowsCalculator");
  });

  it("matches case-insensitively with punctuation noise", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "  calculator!! " });
    expect(res.isError).toBeFalsy();
    expect(launched).toHaveLength(1);
  });

  it("returns candidates instead of launching when ambiguous", async () => {
    const handler = getToolHandler("launch_app");
    // "google" prefix-matches both Google Chrome and Google Drive
    const res = await handler({ name: "google" });
    expect(res.isError).toBeFalsy();
    expect(launched).toHaveLength(0);
    expect(res.content).toContain("ambiguous");
    expect(res.content).toContain("Google Chrome");
    expect(res.content).toContain("Google Drive");
    const outputs = res.outputs as { launched: boolean; candidates: string[] };
    expect(outputs.launched).toBe(false);
    expect(outputs.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces fuzzy candidates for a grandma-style phrasing", async () => {
    const handler = getToolHandler("launch_app");
    // "googles" — token-prefix match against the Google apps
    const res = await handler({ name: "googles" });
    expect(launched).toHaveLength(0);
    expect(res.content).toContain("Google Chrome");
  });

  it("learns an alias after a successful launch and resolves it instantly", async () => {
    const handler = getToolHandler("launch_app");

    const first = await handler({ name: "Google Chrome", alias: "googles" });
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain("Remembered 'googles'");
    expect(launched).toHaveLength(1);
    expect(existsSync(aliasFile())).toBe(true);

    const store = JSON.parse(readFileSync(aliasFile(), "utf-8")) as {
      aliases: Record<string, { name: string }>;
    };
    expect(store.aliases["googles"]!.name).toBe("Google Chrome");

    // Now the learned phrasing resolves with no ambiguity.
    const second = await handler({ name: "googles" });
    expect(second.isError).toBeFalsy();
    expect(second.content).toContain("Launch dispatched: 'Google Chrome'");
    expect(launched).toHaveLength(2);
  });

  it("does not store an alias identical to the app name", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator", alias: "calculator" });
    expect(res.isError).toBeFalsy();
    expect(existsSync(aliasFile())).toBe(false);
  });

  it("does not learn an alias when the launch fails", async () => {
    setLaunchAppDeps({
      spawnApp: async () => {
        throw new Error("spawn exploded");
      },
    });
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator", alias: "calc thing" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Failed to launch");
    expect(res.content).toContain("spawn exploded");
    expect(existsSync(aliasFile())).toBe(false);
  });

  it("dry_run resolves without launching", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator", dry_run: true });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("[dry run]");
    expect(res.content).toContain("Nothing was launched");
    expect(launched).toHaveLength(0);
    const outputs = res.outputs as { resolved: boolean; launched: boolean };
    expect(outputs.resolved).toBe(true);
    expect(outputs.launched).toBe(false);
  });

  it("rescans once on a total miss and finds a newly installed app", async () => {
    const handler = getToolHandler("launch_app");

    // Prime the cache with the initial app list.
    await handler({ name: "Calculator" });
    expect(scanCalls).toBe(1);

    // Install a new app, age the cache past the miss-rescan guard, then
    // ask for it — cache misses, rescan finds it.
    installedApps = [...APPS, { name: "Blender", appId: "Blender.Blender" }];
    fakeNow += 6 * 60 * 1000;
    const res = await handler({ name: "Blender" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("Launch dispatched: 'Blender'");
    expect(scanCalls).toBe(2);
  });

  it("reports an honest no-match with learning instructions", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "flurbo" });
    expect(res.isError).toBeFalsy();
    expect(launched).toHaveLength(0);
    expect(res.content).toContain("No installed app matches 'flurbo'");
    expect(res.content).toContain("alias='flurbo'");
  });

  it("fails honestly when the app scan itself fails", async () => {
    setLaunchAppDeps({
      scanApps: async () => {
        throw new Error("powershell unavailable");
      },
    });
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Calculator" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Could not scan installed apps");
    expect(res.content).toContain("powershell unavailable");
  });

  it("success message admits dispatch-only verification", async () => {
    const handler = getToolHandler("launch_app");
    const res = await handler({ name: "Steam" });
    expect(res.content).toContain("not verified");
  });
});
