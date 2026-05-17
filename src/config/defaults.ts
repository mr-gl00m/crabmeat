import type { Config } from "./schema.js";

/**
 * Minimal development config. Requires at least one provider to be
 * useful, but this gives a valid shape for testing and startup.
 */
export const defaultConfig: Omit<Config, "providers"> & {
  providers: Config["providers"] | [];
} = {
  gateway: {
    host: "127.0.0.1",
    port: 3000,
    auth: { mode: "token" },
    origins: ["http://localhost:*"],
    trustProxy: false,
  },
  agents: [
    {
      id: "default",
      name: "CrabMeat Agent",
      systemPrompt: "You are a helpful AI assistant.",
      temperature: 0.7,
      maxTokens: 4096,
      tools: [],
      allowedEffects: ["read"],
      charsPerToken: 3.5,
      strictInstructions: false,
      maxToolIterations: 5,
      toolRateLimit: {
        maxCalls: 20,
        windowMs: 60_000,
        lockoutMs: 30_000,
      },
      providerPriority: "config-order",
    },
  ],
  providers: [],
  tools: [],
  session: {
    backend: "json",
    dir: ".crabmeat/sessions",
    maxTranscriptEntries: 200,
    retentionDays: 30,
  },
  routing: {
    defaultAgentId: "default",
    bindings: [],
  },
  audit: {
    enabled: true,
    maxEntries: 10_000,
    persistDir: ".crabmeat/audit",
    flushThreshold: 10,
  },
  admin: {
    enabled: false,
  },
  layer2: {
    enabled: false,
    providerId: "",
    confidenceThreshold: 0.5,
    confidenceCeiling: 0.69,
    maxTokens: 256,
    temperature: 0.3,
    escalationMarkers: [
      "I'm not sure",
      "I don't know",
      "I cannot determine",
      "you should ask",
      "beyond my capability",
      "I need more context",
      "this is complex",
      "I'm unable to",
    ],
    healthCheckTimeoutMs: 2000,
    showLayerBadge: false,
    systemPrompt:
      "You are a disambiguation assistant. Your job is to clarify ambiguous user requests. " +
      "Ask a single, specific clarifying question if the intent is unclear. " +
      "If you can confidently answer a simple question, do so briefly in 1-2 sentences. " +
      "If the request requires deep reasoning, complex analysis, or code generation, " +
      "respond with exactly: \"I need more context\" so it can be escalated to a more capable model.",
  },
  skills: {
    enabled: false,
    dir: ".crabmeat/skills",
    maxSkillSizeChars: 8_000,
    maxTotalChars: 32_000,
  },
  webhooks: {
    enabled: false,
    basePath: "/hook",
    requireSecret: true,
  },
  connectors: {
    echo: false,
  },
  hooks: {
    disableAll: false,
    managedOnlyMode: false,
    handlers: {},
  },
  cortexDream: {
    enabled: false,
    memoryDir: ".crabmeat/memory",
    sessionsDir: ".crabmeat/sessions",
    minHoursBetweenRuns: 24,
    minSessionsBetweenRuns: 5,
    throttleMs: 10 * 60 * 1000,
    lockStaleMs: 60 * 60 * 1000,
  },
  refusalFallback: {
    enabled: false,
    fallbackProviderIds: [],
    contentClassAllowlist: [],
    leadBytes: 200,
    rerouteUnclassified: false,
  },
  allowLocalProviders: false,
  fileAccessPaths: [],
  fileAccessPresets: [],
  modelPresets: {},
};
