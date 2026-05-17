import { describe, it, expect } from "vitest";
import {
  configSchema,
  expandFileAccessPresets,
  gatewayConfigSchema,
  providerConfigSchema,
  agentConfigSchema,
} from "./schema.js";

describe("gatewayConfigSchema", () => {
  it("applies defaults for minimal input", () => {
    const result = gatewayConfigSchema.parse({ auth: { mode: "none" } });
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(3000);
    expect(result.auth.mode).toBe("none");
    expect(result.origins).toEqual(["http://localhost:*"]);
  });

  it("rejects invalid port", () => {
    const result = gatewayConfigSchema.safeParse({
      auth: { mode: "none" },
      port: 99999,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid TLS config", () => {
    const result = gatewayConfigSchema.parse({
      auth: { mode: "none" },
      tls: { cert: "/path/to/cert.pem", key: "/path/to/key.pem" },
    });
    expect(result.tls?.cert).toBe("/path/to/cert.pem");
  });

  it("rejects token mode without a token", () => {
    const result = gatewayConfigSchema.safeParse({
      auth: { mode: "token" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects password mode without a password", () => {
    const result = gatewayConfigSchema.safeParse({
      auth: { mode: "password" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts token mode with a token", () => {
    const result = gatewayConfigSchema.safeParse({
      auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" },
    });
    expect(result.success).toBe(true);
  });
});

describe("configSchema", () => {
  it("validates a complete config", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [
        { id: "openai", type: "openai", apiKey: "sk-xxx", model: "gpt-4.1" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toHaveLength(1);
      expect(result.data.agents[0]!.id).toBe("default");
    }
  });

  it("rejects config without providers", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema strict mode (Phase 4.18.3)", () => {
  function base() {
    return {
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
    };
  }

  it("rejects unknown top-level keys", () => {
    const result = configSchema.safeParse({
      ...base(),
      thisIsATypo: { whatever: 42 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => /Unknown top-level config key 'thisIsATypo'/.test(m))).toBe(true);
    }
  });

  it("tolerates `_`-prefixed top-level keys as inline comments", () => {
    const result = configSchema.safeParse({
      ...base(),
      _comment: "this is a JSON comment",
      _migration_note: "refactor pending",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a stale layer0 block (now removed in Arbiter Phase 5)", () => {
    // The schema's .strict() catches it; the loader's
    // assertNoDeprecatedKeys gives a friendlier migration message
    // before this point — but the schema itself must also refuse,
    // so direct configSchema.parse callers don't silently accept it.
    const result = configSchema.safeParse({
      ...base(),
      layer0: { enabled: true, classifierKeywords: ["foo"] },
    });
    expect(result.success).toBe(false);
  });

  it("still accepts the documented top-level keys", () => {
    const result = configSchema.safeParse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      allowLocalProviders: true,
      fileAccessPresets: ["downloads"],
      modelPresets: { "1": "hermes3:latest" },
    });
    expect(result.success).toBe(true);
  });
});

describe("providerConfigSchema role field", () => {
  const base = { id: "p1", type: "openai", apiKey: "sk-x", model: "m" };

  it("accepts a config without a role tag (advisory metadata is optional)", () => {
    const result = providerConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBeUndefined();
    }
  });

  it("accepts each valid role enum value", () => {
    for (const role of ["primary", "backup", "uncensored"] as const) {
      const result = providerConfigSchema.safeParse({ ...base, role });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.role).toBe(role);
    }
  });

  it("rejects an unknown role value", () => {
    const result = providerConfigSchema.safeParse({ ...base, role: "experimental" });
    expect(result.success).toBe(false);
  });
});

describe("fileAccessPaths schema (RT-2026-05-01-006)", () => {
  function parseWith(paths: unknown) {
    return configSchema.safeParse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      fileAccessPaths: paths,
    });
  }

  it("accepts a normal absolute project path", () => {
    const ok = parseWith(["C:/Users/me/Documents/notes"]);
    expect(ok.success).toBe(true);
  });

  it("rejects an empty string entry", () => {
    expect(parseWith([""]).success).toBe(false);
    expect(parseWith(["   "]).success).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(parseWith(["./relative"]).success).toBe(false);
    expect(parseWith(["relative/path"]).success).toBe(false);
  });

  it("rejects paths containing traversal segments", () => {
    expect(parseWith(["C:/Users/me/../../../"]).success).toBe(false);
    expect(parseWith(["/home/user/../etc"]).success).toBe(false);
  });

  it("rejects the POSIX root", () => {
    expect(parseWith(["/"]).success).toBe(false);
  });

  it("rejects Windows drive roots", () => {
    expect(parseWith(["C:/"]).success).toBe(false);
    expect(parseWith(["C:\\"]).success).toBe(false);
    expect(parseWith(["D:"]).success).toBe(false);
    expect(parseWith(["Z:/"]).success).toBe(false);
  });

  it("rejects bare UNC share roots", () => {
    expect(parseWith(["\\\\server\\share"]).success).toBe(false);
    expect(parseWith(["\\\\server\\share\\"]).success).toBe(false);
  });

  it("accepts a subfolder inside a UNC share", () => {
    const result = parseWith(["\\\\server\\share\\project"]);
    expect(result.success).toBe(true);
  });

  it("flags every bad entry, not just the first", () => {
    const result = parseWith(["/", "C:/", "C:/Users/me/Documents/notes"]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("fileAccessPresets schema", () => {
  function parseWith(presets: unknown) {
    return configSchema.safeParse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      fileAccessPresets: presets,
    });
  }

  it("accepts common user-folder presets", () => {
    const result = parseWith(["downloads", "documents", "desktop"]);
    expect(result.success).toBe(true);
  });

  it("rejects unknown presets", () => {
    expect(parseWith(["home"]).success).toBe(false);
    expect(parseWith(["everything"]).success).toBe(false);
  });

  it("expands presets to absolute home subdirectories", () => {
    const paths = expandFileAccessPresets(["downloads", "downloads", "desktop"]);
    expect(paths.length).toBe(2);
    expect(paths[0]).toMatch(/Downloads$/i);
    expect(paths[1]).toMatch(/Desktop$/i);
  });
});

describe("agentConfigSchema providerPriority field", () => {
  it("defaults to config-order when omitted", () => {
    const result = agentConfigSchema.parse({});
    expect(result.providerPriority).toBe("config-order");
  });

  it("accepts each valid priority mode", () => {
    for (const mode of ["config-order", "api-first", "local-first"] as const) {
      const result = agentConfigSchema.safeParse({ providerPriority: mode });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.providerPriority).toBe(mode);
    }
  });

  it("rejects an unknown priority mode", () => {
    const result = agentConfigSchema.safeParse({ providerPriority: "smart" });
    expect(result.success).toBe(false);
  });
});
