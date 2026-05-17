import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolCatalog,
  loadOrCreateCapSecret,
  _resetCapSecretCacheForTests,
} from "./catalog.js";
import type { Config } from "../../config/types.js";

function makeConfig(tools: Config["tools"] = []): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: 3000,
      auth: { mode: "none" },
      origins: [],
    },
    agents: [{
      id: "test-agent",
      name: "Test",
      systemPrompt: "test",
      temperature: 0.7,
      maxTokens: 4096,
      tools: ["search", "read_file"],
      allowedEffects: ["read", "network"],
      maxToolIterations: 5,
    }],
    providers: [{ id: "mock", type: "openai", apiKey: "sk-test", model: "m", maxRetries: 0, timeoutMs: 5000 }],
    session: { backend: "json", dir: ".test", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "test-agent", bindings: [] },
    tools,
  };
}

const TEST_TOOLS: Config["tools"] = [
  {
    id: "search",
    name: "web_search",
    description: "Search the web",
    parameters: {
      query: { type: "string", required: true, secretRef: false },
      limit: { type: "number", required: false, default: 10, secretRef: false },
    },
    effectClass: "network",
  },
  {
    id: "read_file",
    name: "read_file",
    description: "Read a file from disk",
    parameters: {
      path: { type: "string", required: true, secretRef: false },
    },
    effectClass: "read",
  },
  {
    id: "delete_file",
    name: "delete_file",
    description: "Delete a file",
    parameters: {
      path: { type: "string", required: true, secretRef: false },
    },
    effectClass: "write",
  },
];

describe("createToolCatalog", () => {
  it("registers tools from config", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    expect(catalog.size).toBe(3);
    expect(catalog.get("search")).toBeDefined();
    expect(catalog.get("read_file")).toBeDefined();
    expect(catalog.get("nonexistent")).toBeUndefined();
  });

  it("handles empty tools config", () => {
    const catalog = createToolCatalog(makeConfig([]));
    expect(catalog.size).toBe(0);
  });

  it("handles missing tools field gracefully", () => {
    const config = makeConfig([]);
    delete (config as any).tools;
    const catalog = createToolCatalog(config);
    expect(catalog.size).toBe(0);
  });
});

describe("capability ID minting", () => {
  it("produces deterministic cap IDs for same session + tool", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const map1 = catalog.mintCapabilityMap("session-abc");
    const map2 = catalog.mintCapabilityMap("session-abc");
    expect([...map1.entries()]).toEqual([...map2.entries()]);
  });

  it("produces different cap IDs for different sessions", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const map1 = catalog.mintCapabilityMap("session-1");
    const map2 = catalog.mintCapabilityMap("session-2");

    const caps1 = [...map1.keys()].sort();
    const caps2 = [...map2.keys()].sort();
    expect(caps1).not.toEqual(caps2);
  });

  it("produces cap IDs with correct format", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const capMap = catalog.mintCapabilityMap("session-test");
    for (const capId of capMap.keys()) {
      expect(capId).toMatch(/^cap_[a-f0-9]{12}$/);
    }
  });

  it("maps all registered tools", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const capMap = catalog.mintCapabilityMap("session-test");
    expect(capMap.size).toBe(3);
    const toolIds = new Set(capMap.values());
    expect(toolIds.has("search")).toBe(true);
    expect(toolIds.has("read_file")).toBe(true);
    expect(toolIds.has("delete_file")).toBe(true);
  });

  it("has no cap ID collisions within a session", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const capMap = catalog.mintCapabilityMap("session-test");
    const capIds = [...capMap.keys()];
    expect(new Set(capIds).size).toBe(capIds.length);
  });
});

describe("getAvailableTools", () => {
  it("filters by agent's tool list", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const agent = makeConfig(TEST_TOOLS).agents[0]!;
    const available = catalog.getAvailableTools(agent);
    expect(available).toHaveLength(2); // search and read_file, not delete_file
    expect(available.map((t) => t.id).sort()).toEqual(["read_file", "search"]);
  });

  it("returns empty for agent with no tools", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const agent = { ...makeConfig(TEST_TOOLS).agents[0]!, tools: [] };
    expect(catalog.getAvailableTools(agent)).toHaveLength(0);
  });
});

describe("getToolDeclarations", () => {
  it("uses cap IDs as function names", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const agent = makeConfig(TEST_TOOLS).agents[0]!;
    const capMap = catalog.mintCapabilityMap("session-1");
    const declarations = catalog.getToolDeclarations(agent, capMap);

    expect(declarations).toHaveLength(2);
    for (const decl of declarations) {
      expect(decl.name).toMatch(/^cap_[a-f0-9]{12}$/);
    }
  });

  it("includes descriptions from tool definitions", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const agent = makeConfig(TEST_TOOLS).agents[0]!;
    const capMap = catalog.mintCapabilityMap("session-1");
    const declarations = catalog.getToolDeclarations(agent, capMap);

    const descs = declarations.map((d) => d.description).sort();
    expect(descs).toEqual(["Read a file from disk", "Search the web"]);
  });

  it("includes JSON Schema parameters", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const agent = makeConfig(TEST_TOOLS).agents[0]!;
    const capMap = catalog.mintCapabilityMap("session-1");
    const declarations = catalog.getToolDeclarations(agent, capMap);

    const searchDecl = declarations.find((d) => d.description === "Search the web")!;
    expect(searchDecl.parameters).toHaveProperty("type", "object");
    expect((searchDecl.parameters as any).properties).toHaveProperty("query");
    expect((searchDecl.parameters as any).required).toContain("query");
  });
});

describe("resolveCapability", () => {
  it("resolves valid cap IDs to tool IDs", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const capMap = catalog.mintCapabilityMap("session-1");
    for (const [capId, toolId] of capMap) {
      expect(catalog.resolveCapability(capId, capMap)).toBe(toolId);
    }
  });

  it("returns undefined for unknown cap IDs", () => {
    const catalog = createToolCatalog(makeConfig(TEST_TOOLS));
    const capMap = catalog.mintCapabilityMap("session-1");
    expect(catalog.resolveCapability("cap_000000000000", capMap)).toBeUndefined();
    expect(catalog.resolveCapability("web_search", capMap)).toBeUndefined();
  });
});

describe("loadOrCreateCapSecret (RT-2026-05-01-008)", () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpRoot = await mkdtemp(join(tmpdir(), "crabmeat-cap-secret-"));
    process.chdir(tmpRoot);
    _resetCapSecretCacheForTests();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    _resetCapSecretCacheForTests();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates a 64-char hex secret on first run and persists it atomically", async () => {
    const secret = await loadOrCreateCapSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = (await readFile(join(tmpRoot, ".crabmeat", "cap-secret"), "utf-8")).trim();
    expect(onDisk).toBe(secret);
  });

  it("reuses an existing well-formed secret across loads", async () => {
    const first = await loadOrCreateCapSecret();
    _resetCapSecretCacheForTests();
    const second = await loadOrCreateCapSecret();
    expect(second).toBe(first);
  });

  it("fails closed when the on-disk secret is malformed (wrong length)", async () => {
    await mkdir(join(tmpRoot, ".crabmeat"), { recursive: true });
    await writeFile(join(tmpRoot, ".crabmeat", "cap-secret"), "deadbeef", "utf-8");
    await expect(loadOrCreateCapSecret()).rejects.toThrow(/malformed/i);
  });

  it("fails closed when the on-disk secret has non-hex chars", async () => {
    await mkdir(join(tmpRoot, ".crabmeat"), { recursive: true });
    await writeFile(
      join(tmpRoot, ".crabmeat", "cap-secret"),
      "z".repeat(64),
      "utf-8",
    );
    await expect(loadOrCreateCapSecret()).rejects.toThrow(/malformed/i);
  });
});
