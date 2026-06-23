import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/fs.js";
import type {
  Config,
  AgentConfig,
  ToolParameterConfig,
  ToolOutputConfig,
} from "../../config/types.js";
import { isOwnerOnlyToolName, type CallerRole } from "../../security/owner-only-tools.js";
import type {
  ToolDefinition,
  CapabilityMap,
  ToolDeclaration,
  ToolParameterDef,
  ToolOutputDef,
} from "./types.js";

/**
 * Semver of the shell↔engine tool contract: the set of canonical tool ids,
 * their parameter schemas, and the result envelope ({ content, isError,
 * outputs }). External shells (PolyGlot, future GUIs) pin against THIS
 * version, not the package version — engine internals can change freely
 * without touching it. Bump minor for additive changes (new tools, new
 * optional params), major for anything that renames, removes, or changes
 * the meaning of an existing tool or parameter.
 */
export const TOOL_CONTRACT_VERSION = "1.0.0";

export interface ToolCatalog {
  /** Get a tool definition by ID. */
  get(toolId: string): ToolDefinition | undefined;

  /**
   * Get all tool definitions available to an agent. When `callerRole` is
   * provided and is not "owner", owner-only tools are filtered out so a
   * non-owner caller cannot see (or therefore reach) them.
   */
  getAvailableTools(agentConfig: AgentConfig, callerRole?: CallerRole): ToolDefinition[];

  /** Mint a per-session capability map (cached). */
  mintCapabilityMap(sessionKey: string): CapabilityMap;

  /**
   * Generate LLM-facing tool declarations with cap IDs as names.
   * When `callerRole` is provided and is not "owner", owner-only tools
   * are filtered out — they don't appear in the surfaced catalog at all.
   */
  getToolDeclarations(
    agentConfig: AgentConfig,
    capMap: CapabilityMap,
    callerRole?: CallerRole,
  ): ToolDeclaration[];

  /** Resolve a capability ID back to a tool ID. Returns undefined if invalid. */
  resolveCapability(capId: string, capMap: CapabilityMap): string | undefined;

  /** Number of registered tools. */
  readonly size: number;
}

/**
 * Build a Zod object schema from parameter config definitions.
 * Supports flat parameter types for Phase 3 Tier 1.
 */
function buildParameterSchema(
  params: Record<string, ToolParameterConfig>,
): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const [name, param] of Object.entries(params)) {
    let fieldSchema: z.ZodTypeAny;

    switch (param.type) {
      case "string":
        fieldSchema = z.string();
        break;
      case "number":
        fieldSchema = z.number();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      case "object":
        fieldSchema = z.record(z.string(), z.unknown());
        break;
      case "array":
        fieldSchema = z.array(z.unknown());
        break;
    }

    if (param.enum && param.enum.length > 0) {
      fieldSchema = z.enum(param.enum.map(String) as [string, ...string[]]);
    }

    if (!param.required) {
      fieldSchema = fieldSchema.optional();
      if (param.default !== undefined) {
        fieldSchema = fieldSchema.default(param.default);
      }
    }

    shape[name] = fieldSchema;
  }

  return z.object(shape);
}

/**
 * Convert config parameter definitions to the runtime ToolParameterDef format.
 */
function toParameterDefs(
  params: Record<string, ToolParameterConfig>,
): Record<string, ToolParameterDef> {
  const result: Record<string, ToolParameterDef> = {};
  for (const [name, param] of Object.entries(params)) {
    result[name] = {
      type: param.type,
      description: param.description,
      required: param.required,
      enum: param.enum as ReadonlyArray<string | number> | undefined,
      default: param.default,
      secretRef: param.secretRef,
    };
  }
  return result;
}

/**
 * Convert config output definitions to the runtime ToolOutputDef format.
 */
function toOutputDefs(
  outputs: Record<string, ToolOutputConfig>,
): Record<string, ToolOutputDef> {
  const result: Record<string, ToolOutputDef> = {};
  for (const [name, out] of Object.entries(outputs)) {
    result[name] = {
      type: out.type,
      description: out.description,
      required: out.required,
    };
  }
  return result;
}

/**
 * Convert a Zod schema to a JSON Schema subset for LLM tool declarations.
 */
function toJsonSchema(
  params: Record<string, ToolParameterConfig>,
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: param.type };
    if (param.description) prop.description = param.description;
    if (param.enum) prop.enum = param.enum;

    // Don't expose secret ref parameters — the LLM just sees a string
    if (param.secretRef) {
      prop.type = "string";
      prop.description = (param.description ?? name) + " (secret reference)";
    }

    properties[name] = prop;
    if (param.required) required.push(name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Load or generate a per-deployment secret used for capability ID HMAC.
 * Persisted to .crabmeat/cap-secret so cap IDs are stable across restarts
 * but unique per deployment (not predictable from source code).
 */
const CAP_SECRET_PATH = join(".crabmeat", "cap-secret");
// 32 bytes of randomness, hex-encoded, is the format we mint. We accept and
// require exactly that on load so a partially-written or hand-edited file
// fails closed instead of silently producing different cap IDs across restarts.
const CAP_SECRET_HEX_LEN = 64;
const CAP_SECRET_RE = /^[0-9a-f]{64}$/;
let deploymentSecret: string | null = null;

export async function loadOrCreateCapSecret(): Promise<string> {
  if (deploymentSecret) return deploymentSecret;
  let existing: string | null = null;
  try {
    existing = (await readFile(CAP_SECRET_PATH, "utf-8")).trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (existing !== null) {
    if (!CAP_SECRET_RE.test(existing)) {
      throw new Error(
        `cap-secret at ${CAP_SECRET_PATH} is malformed: expected ${CAP_SECRET_HEX_LEN} hex chars. ` +
          `Refusing to start; remove the file to regenerate (this will invalidate existing capability IDs).`,
      );
    }
    deploymentSecret = existing;
    return deploymentSecret;
  }
  const minted = randomBytes(32).toString("hex");
  await writeFileAtomic(CAP_SECRET_PATH, minted);
  deploymentSecret = minted;
  return deploymentSecret;
}

// Test helper: reset the in-memory cache so a test can exercise load-from-disk
// behavior without process restart.
export function _resetCapSecretCacheForTests(): void {
  deploymentSecret = null;
}

/**
 * Mint a capability ID for a tool within a session.
 * Deterministic: same sessionKey + toolId + deployment secret = same cap ID.
 * The deployment secret prevents cap ID precomputation from source code.
 */
function mintCapabilityId(sessionKey: string, toolId: string, secret: string): string {
  return (
    "cap_" +
    createHmac("sha256", secret)
      .update(sessionKey + "\0" + toolId)
      .digest("hex")
      .slice(0, 12)
  );
}

export function createToolCatalog(config: Config, capSecret: string = "crabmeat-cap-v1"): ToolCatalog {
  const registry = new Map<string, ToolDefinition>();
  const configParams = new Map<string, Record<string, ToolParameterConfig>>();
  const capMapCache = new Map<string, CapabilityMap>();
  const MAX_CAP_MAP_CACHE = 500;

  // Build registry from config (tools may be undefined in test configs).
  // ownerOnly is resolved here so that downstream filtering and validate-
  // time checks read off the same source of truth (canonical tool id).
  for (const toolDef of config.tools ?? []) {
    const parameterSchema = buildParameterSchema(toolDef.parameters);
    registry.set(toolDef.id, {
      id: toolDef.id,
      name: toolDef.name,
      description: toolDef.description,
      parameters: toParameterDefs(toolDef.parameters),
      outputs: toOutputDefs(toolDef.outputs ?? {}),
      effectClass: toolDef.effectClass,
      parameterSchema,
      ownerOnly: isOwnerOnlyToolName(toolDef.id),
    });
    configParams.set(toolDef.id, toolDef.parameters);
  }

  return {
    get size() {
      return registry.size;
    },

    get(toolId: string): ToolDefinition | undefined {
      return registry.get(toolId);
    },

    getAvailableTools(
      agentConfig: AgentConfig,
      callerRole?: CallerRole,
    ): ToolDefinition[] {
      if (agentConfig.tools.length === 0) return [];
      const tools = agentConfig.tools
        .map((id) => registry.get(id))
        .filter((t): t is ToolDefinition => t !== undefined);
      // Strip owner-only tools when the caller isn't owner. Absent
      // callerRole keeps the legacy behavior (treated as owner) so
      // pre-existing callers don't change shape.
      if (callerRole !== undefined && callerRole !== "owner") {
        return tools.filter((t) => t.ownerOnly !== true);
      }
      return tools;
    },

    mintCapabilityMap(sessionKey: string): CapabilityMap {
      const cached = capMapCache.get(sessionKey);
      if (cached) return cached;

      const capMap: CapabilityMap = new Map();
      for (const toolId of registry.keys()) {
        const capId = mintCapabilityId(sessionKey, toolId, capSecret);
        capMap.set(capId, toolId);
      }
      // Evict oldest entry if cache is full (LRU via Map insertion order)
      if (capMapCache.size >= MAX_CAP_MAP_CACHE) {
        const oldest = capMapCache.keys().next().value!;
        capMapCache.delete(oldest);
      }
      capMapCache.set(sessionKey, capMap);
      return capMap;
    },

    getToolDeclarations(
      agentConfig: AgentConfig,
      capMap: CapabilityMap,
      callerRole?: CallerRole,
    ): ToolDeclaration[] {
      const available = this.getAvailableTools(agentConfig, callerRole);
      // Build reverse map: toolId → capId
      const toolToCapId = new Map<string, string>();
      for (const [capId, toolId] of capMap) {
        toolToCapId.set(toolId, capId);
      }

      return available
        .map((tool) => {
          const capId = toolToCapId.get(tool.id);
          if (!capId) return null;
          const params = configParams.get(tool.id) ?? {};
          return {
            name: capId,
            description: tool.description,
            parameters: toJsonSchema(params),
          };
        })
        .filter((d): d is ToolDeclaration => d !== null);
    },

    resolveCapability(
      capId: string,
      capMap: CapabilityMap,
    ): string | undefined {
      return capMap.get(capId);
    },
  };
}
