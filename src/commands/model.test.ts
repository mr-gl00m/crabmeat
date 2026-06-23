/**
 * Tests for /model command — specifically the modelPresets path that
 * lets users wire stable numeric shortcuts (e.g. `/model swap 1` →
 * always Hermes, `/model 2` → always GPT-OSS) regardless of how Ollama
 * orders its tag list today.
 *
 * The dynamic-index path is exercised indirectly: when no preset is
 * configured for the requested slot, the resolver must fall back to
 * the Ollama tag list and behave as it did before presets existed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./handlers.js"; // registers built-in commands
import { getCommand, type CommandContext } from "./registry.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { Config } from "../config/types.js";
import type { InferencePipeline } from "../agents/inference.js";

function makeSession(): Session {
  const now = new Date().toISOString();
  return {
    sessionKey: "test-session",
    agentId: "default",
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeStore(initial: Session): SessionStore {
  let current: Session = initial;
  return {
    async load(key) {
      return key === current.sessionKey ? current : undefined;
    },
    async save(s) {
      current = s;
    },
    create(key, agentId) {
      const now = new Date().toISOString();
      return {
        sessionKey: key,
        agentId,
        transcript: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async list() {
      return [current.sessionKey];
    },
  };
}

let cooldownResets = 0;
function makePipeline(): InferencePipeline {
  return {
    async handleTurn() {
      /* unused */
    },
    getProvider() {
      return undefined;
    },
    resetProviderCooldowns() {
      cooldownResets++;
    },
    toolCatalog: {} as never,
    auditLog: {} as never,
    hookRunner: {} as never,
  };
}

interface TestProvider {
  id: string;
  type: "openai";
  apiKey: string;
  baseUrl: string;
  model: string;
  maxRetries: number;
  timeoutMs: number;
}

function makeConfig(opts: {
  presets?: Record<string, string>;
  currentModel?: string;
}): { config: Config; provider: TestProvider } {
  const provider: TestProvider = {
    id: "ollama-local",
    type: "openai",
    apiKey: "x",
    baseUrl: "http://localhost:11434/v1",
    model: opts.currentModel ?? "starting:latest",
    maxRetries: 0,
    timeoutMs: 1000,
  };
  const config = {
    providers: [provider],
    agents: [{ id: "default" }],
    layer2: { enabled: false } as never,
    modelPresets: opts.presets ?? {},
  } as unknown as Config;
  return { config, provider };
}

function makeCtx(args: string, config: Config): CommandContext {
  return {
    sink: {} as never,
    sessionKey: "test-session",
    frameId: "frame-1",
    config,
    store: makeStore(makeSession()),
    pipeline: makePipeline(),
    args,
  };
}

/**
 * Mock the Ollama HTTP API. Returns a fixed model list so tests are
 * deterministic regardless of what's actually pulled on the dev box.
 */
function mockOllama(models: string[]) {
  const tagsBody = {
    models: models.map((name) => ({ name, size: 1_000_000_000, modified_at: "2026-01-01T00:00:00Z" })),
  };
  const psBody = { models: [] as Array<{ name: string }> };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/tags")) {
      return { ok: true, json: async () => tagsBody } as unknown as Response;
    }
    if (url.includes("/api/ps")) {
      return { ok: true, json: async () => psBody } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  cooldownResets = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/model presets — numeric resolver", () => {
  it("`/model 1` swaps to the configured preset, ignoring Ollama's index order", async () => {
    mockOllama(["unrelated:latest", "another:latest", "hermes3:latest"]);
    const { config, provider } = makeConfig({
      presets: { "1": "hermes3:latest", "2": "another:latest" },
    });

    const result = await getCommand("model")!.handler(makeCtx("1", config));

    // Without presets, slot 1 would be "unrelated:latest" (Ollama index 0).
    // With presets, slot 1 is the user's hermes3:latest.
    expect(provider.model).toBe("hermes3:latest");
    expect(result.output).toContain("hermes3:latest");
    expect(cooldownResets).toBe(1);
  });

  it("`/model swap 2` is identical to `/model 2` (numeric goes through preset path)", async () => {
    mockOllama(["a:latest", "b:latest", "hermes3:latest"]);
    const { config, provider } = makeConfig({
      presets: { "2": "hermes3:latest" },
    });

    await getCommand("model")!.handler(makeCtx("swap 2", config));
    expect(provider.model).toBe("hermes3:latest");
  });

  it("falls back to Ollama dynamic index when the slot has no preset", async () => {
    mockOllama(["zero:latest", "one:latest", "two:latest"]);
    const { config, provider } = makeConfig({
      presets: { "1": "hermes3:latest" }, // only slot 1 mapped
    });

    // Slot 3 is unmapped → use dynamic index → result.available[2] → "two:latest"
    await getCommand("model")!.handler(makeCtx("3", config));
    expect(provider.model).toBe("two:latest");
  });

  it("rejects a preset whose target model isn't pulled with a clear error", async () => {
    mockOllama(["only-this:latest"]);
    const { config, provider } = makeConfig({
      presets: { "1": "hermes3:latest" }, // not in Ollama's list
      currentModel: "only-this:latest",
    });

    const result = await getCommand("model")!.handler(makeCtx("1", config));
    expect(result.output).toContain("not pulled");
    expect(result.output).toContain("hermes3:latest");
    // Provider must NOT have been mutated when the preset is invalid.
    expect(provider.model).toBe("only-this:latest");
    expect(cooldownResets).toBe(0);
  });

  it("`/model swap hermes3:latest` (named) still works alongside numeric presets", async () => {
    mockOllama(["hermes3:latest", "other:latest"]);
    const { config, provider } = makeConfig({
      presets: { "1": "other:latest" },
    });

    await getCommand("model")!.handler(makeCtx("swap hermes3:latest", config));
    expect(provider.model).toBe("hermes3:latest");
  });
});

describe("/model list — preset rendering", () => {
  it("renders configured presets at the top with their state", async () => {
    mockOllama(["hermes3:latest", "gpt-oss:20b", "deepseek-r1:14b"]);
    const { config } = makeConfig({
      presets: {
        "1": "hermes3:latest",
        "2": "gpt-oss:20b",
        "3": "deepseek-r1:14b",
      },
      currentModel: "hermes3:latest",
    });

    const result = await getCommand("model")!.handler(makeCtx("list", config));
    const out = result.output;

    expect(out).toContain("**Presets:**");
    // Presets section appears before the available-models section.
    expect(out.indexOf("**Presets:**")).toBeLessThan(out.indexOf("**Available models:**"));
    // Ordered by slot, not by Ollama index.
    const idx1 = out.indexOf("1. hermes3:latest");
    const idx2 = out.indexOf("2. gpt-oss:20b");
    const idx3 = out.indexOf("3. deepseek-r1:14b");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    // Active marker is on the preset line, not just the available list.
    expect(out).toMatch(/1\. hermes3:latest.*active/);
  });

  it("flags a preset whose model isn't pulled", async () => {
    mockOllama(["other:latest"]);
    const { config } = makeConfig({
      presets: { "1": "missing:latest" },
    });

    const result = await getCommand("model")!.handler(makeCtx("list", config));
    expect(result.output).toMatch(/1\. missing:latest.*not pulled/);
  });

  it("omits the presets section entirely when none are configured", async () => {
    mockOllama(["a:latest", "b:latest"]);
    const { config } = makeConfig({});

    const result = await getCommand("model")!.handler(makeCtx("list", config));
    expect(result.output).not.toContain("**Presets:**");
    expect(result.output).toContain("**Available models:**");
  });
});
