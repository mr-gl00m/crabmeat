import { describe, it, expect } from "vitest";
import { validateToolInvocation } from "./validate.js";
import { createToolCatalog } from "./catalog.js";
import type { Config, AgentConfig } from "../../config/types.js";
import type { ToolInvocation } from "./types.js";

function makeConfig(): Config {
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
      tools: ["search"],
      allowedEffects: ["read", "network"],
      maxToolIterations: 5,
    }],
    providers: [{ id: "mock", type: "openai", apiKey: "sk-test", model: "m", maxRetries: 0, timeoutMs: 5000 }],
    session: { backend: "json", dir: ".test", maxTranscriptEntries: 200, retentionDays: 30 },
    routing: { defaultAgentId: "test-agent", bindings: [] },
    tools: [
      {
        id: "search",
        name: "web_search",
        description: "Search the web",
        parameters: {
          query: { type: "string", required: true, secretRef: false },
        },
        effectClass: "network",
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
    ],
  };
}

function getCapIdForTool(
  catalog: ReturnType<typeof createToolCatalog>,
  sessionKey: string,
  toolId: string,
): string {
  const capMap = catalog.mintCapabilityMap(sessionKey);
  for (const [capId, tid] of capMap) {
    if (tid === toolId) return capId;
  }
  throw new Error(`No cap ID for tool ${toolId}`);
}

describe("validateToolInvocation", () => {
  const SESSION_KEY = "test-session";

  it("validates a correct invocation", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);
    const capId = getCapIdForTool(catalog, SESSION_KEY, "search");

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: { query: "test search" },
    };

    const result = validateToolInvocation(
      invocation,
      config.agents[0]!,
      capMap,
      catalog,
    );

    expect(result.toolId).toBe("search");
    expect(result.toolName).toBe("web_search");
    expect(result.effectClass).toBe("network");
    expect(result.parameters).toEqual({ query: "test search" });
  });

  it("rejects unknown capability ID", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);

    const invocation: ToolInvocation = {
      capabilityId: "cap_000000000000",
      callId: "call-1",
      arguments: { query: "test" },
    };

    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMap, catalog),
    ).toThrow("Unknown capability ID");
  });

  it("rejects real tool name used as capability ID", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);

    const invocation: ToolInvocation = {
      capabilityId: "web_search",
      callId: "call-1",
      arguments: { query: "test" },
    };

    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMap, catalog),
    ).toThrow("Unknown capability ID");
  });

  it("rejects tool not in agent's allowed list", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);
    const capId = getCapIdForTool(catalog, SESSION_KEY, "delete_file");

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: { path: "/tmp/file" },
    };

    // Agent only has "search" in tools, not "delete_file"
    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMap, catalog),
    ).toThrow("not permitted for this agent");
  });

  it("rejects disallowed effect class", () => {
    const config = makeConfig();
    // Agent allows read and network, but delete_file is write
    const agent: AgentConfig = {
      ...config.agents[0]!,
      tools: ["delete_file"],
      allowedEffects: ["read"], // only read, not write
    };
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);
    const capId = getCapIdForTool(catalog, SESSION_KEY, "delete_file");

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: { path: "/tmp/file" },
    };

    expect(() =>
      validateToolInvocation(invocation, agent, capMap, catalog),
    ).toThrow("Effect class 'write' is not permitted");
  });

  it("rejects invalid parameters", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);
    const capId = getCapIdForTool(catalog, SESSION_KEY, "search");

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: { query: 12345 }, // wrong type: number instead of string
    };

    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMap, catalog),
    ).toThrow("Parameter validation failed");
  });

  it("rejects missing required parameters", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMap = catalog.mintCapabilityMap(SESSION_KEY);
    const capId = getCapIdForTool(catalog, SESSION_KEY, "search");

    const invocation: ToolInvocation = {
      capabilityId: capId,
      callId: "call-1",
      arguments: {}, // missing required "query"
    };

    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMap, catalog),
    ).toThrow("Parameter validation failed");
  });

  it("rejects cap ID from a different session", () => {
    const config = makeConfig();
    const catalog = createToolCatalog(config);
    const capMapSession1 = catalog.mintCapabilityMap("session-1");
    const capMapSession2 = catalog.mintCapabilityMap("session-2");
    const capIdFromSession1 = getCapIdForTool(catalog, "session-1", "search");

    const invocation: ToolInvocation = {
      capabilityId: capIdFromSession1,
      callId: "call-1",
      arguments: { query: "test" },
    };

    // Using session-2's cap map with session-1's cap ID should fail
    expect(() =>
      validateToolInvocation(invocation, config.agents[0]!, capMapSession2, catalog),
    ).toThrow("Unknown capability ID");
  });
});
