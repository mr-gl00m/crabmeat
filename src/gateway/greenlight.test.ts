/**
 * Greenlight protocol tests (Phase 4.19 B1).
 *
 * Exercises the composite verdict shape across each component going
 * red individually + the all-green steady state. The HTTP route handler
 * is exercised separately by the gateway integration tests; this file
 * covers the pure decision logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateGreenlight, formatGreenlightVerdict } from "./greenlight.js";
import { setFeaturesRoot, writeFeature, clearFeature } from "../features/store.js";
import { createCircuitBreaker } from "../security/circuit-breaker.js";
import { configSchema } from "../config/schema.js";
import type { Config } from "../config/types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crabmeat-greenlight-"));
  setFeaturesRoot(tmp);
});

afterEach(() => {
  setFeaturesRoot(undefined);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best */ }
});

function baseConfig(): Config {
  return configSchema.parse({
    gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
    providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
  });
}

describe("evaluateGreenlight", () => {
  it("returns ready when no components are engaged + no live deps provided", async () => {
    await clearFeature("pause");
    const verdict = await evaluateGreenlight({ config: baseConfig() });
    expect(verdict.ready).toBe(true);
    expect(verdict.components).toHaveLength(3);
    expect(verdict.components.map((c) => c.name).sort()).toEqual([
      "circuit-breaker",
      "pause",
      "providers",
    ]);
    // Pause read live; the other two report "not checked" without a live gateway.
    expect(verdict.components.find((c) => c.name === "pause")?.ready).toBe(true);
    expect(verdict.components.find((c) => c.name === "circuit-breaker")?.ready).toBe(true);
    expect(verdict.components.find((c) => c.name === "providers")?.ready).toBe(true);
    expect(verdict.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("flips to NOT ready when the pause toggle is engaged", async () => {
    await writeFeature("pause", { enabled: true, reason: "migration", set_by: "cli" });
    const verdict = await evaluateGreenlight({ config: baseConfig() });
    expect(verdict.ready).toBe(false);
    const pause = verdict.components.find((c) => c.name === "pause")!;
    expect(pause.ready).toBe(false);
    expect(pause.detail).toMatch(/Pause toggle engaged/);
    expect(pause.detail).toMatch(/migration/);
    expect(pause.detail).toMatch(/crabmeat resume/);
  });

  it("does NOT flip to NOT ready when pause is explicitly written disabled", async () => {
    await writeFeature("pause", { enabled: false, set_by: "cli" });
    const verdict = await evaluateGreenlight({ config: baseConfig() });
    expect(verdict.ready).toBe(true);
    expect(verdict.components.find((c) => c.name === "pause")?.ready).toBe(true);
  });

  it("reports circuit-breaker red when the breaker is open", async () => {
    const breaker = createCircuitBreaker();
    breaker.trip("test trip");
    const verdict = await evaluateGreenlight({
      config: baseConfig(),
      circuitBreaker: breaker,
    });
    expect(verdict.ready).toBe(false);
    const cb = verdict.components.find((c) => c.name === "circuit-breaker")!;
    expect(cb.ready).toBe(false);
    expect(cb.detail).toMatch(/Circuit breaker is open/);
    expect(cb.detail).toMatch(/admin\/circuit-breaker/);
  });

  it("reports circuit-breaker green when the breaker is closed", async () => {
    const breaker = createCircuitBreaker();
    const verdict = await evaluateGreenlight({
      config: baseConfig(),
      circuitBreaker: breaker,
    });
    expect(verdict.components.find((c) => c.name === "circuit-breaker")?.ready).toBe(true);
  });

  it("reports providers red when getProvider returns missing for a configured id", async () => {
    const verdict = await evaluateGreenlight({
      config: baseConfig(),
      getProvider: () => undefined,
    });
    expect(verdict.ready).toBe(false);
    const providers = verdict.components.find((c) => c.name === "providers")!;
    expect(providers.ready).toBe(false);
    expect(providers.detail).toMatch(/openai/);
  });

  it("aggregates multiple unreachable providers into one component message", async () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [
        { id: "openai", type: "openai", apiKey: "sk-x", model: "m" },
        { id: "anthropic", type: "anthropic", apiKey: "sk-y", model: "claude" },
      ],
    });
    const verdict = await evaluateGreenlight({
      config: cfg,
      getProvider: () => undefined,
    });
    const providers = verdict.components.find((c) => c.name === "providers")!;
    expect(providers.detail).toMatch(/openai/);
    expect(providers.detail).toMatch(/anthropic/);
  });

  it("composes ALL components — multiple red components keep verdict red", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    const breaker = createCircuitBreaker();
    breaker.trip("test trip");
    const verdict = await evaluateGreenlight({
      config: baseConfig(),
      circuitBreaker: breaker,
      getProvider: () => undefined,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.components.find((c) => c.name === "pause")?.ready).toBe(false);
    expect(verdict.components.find((c) => c.name === "circuit-breaker")?.ready).toBe(false);
    expect(verdict.components.find((c) => c.name === "providers")?.ready).toBe(false);
  });
});

describe("formatGreenlightVerdict", () => {
  it("renders [GREEN] when every component is ready", async () => {
    const verdict = await evaluateGreenlight({ config: baseConfig() });
    const out = formatGreenlightVerdict(verdict);
    expect(out).toMatch(/^\[GREEN\]/);
    expect(out).toMatch(/\[OK\]\s+pause/);
  });

  it("renders [RED] when any component is not ready", async () => {
    await writeFeature("pause", { enabled: true, set_by: "cli" });
    const verdict = await evaluateGreenlight({ config: baseConfig() });
    const out = formatGreenlightVerdict(verdict);
    expect(out).toMatch(/^\[RED\]/);
    expect(out).toMatch(/\[FAIL\] pause/);
  });
});
