import { describe, it, expect } from "vitest";
import { EffectDeniedError } from "../infra/errors.js";
import {
  ALLOWED_OWNER_TOOL_CONFIG_PATHS,
  OWNER_ONLY_TOOL_NAMES,
  assertOwnerOnlyAccess,
  isAllowedOwnerToolConfigPath,
  isOwnerOnlyToolName,
} from "./owner-only-tools.js";

describe("owner-only tool routing", () => {
  describe("OWNER_ONLY_TOOL_NAMES", () => {
    it("ships empty by default — no current crabmeat tool qualifies", () => {
      expect(OWNER_ONLY_TOOL_NAMES).toEqual([]);
    });

    it("isOwnerOnlyToolName returns false for any current tool", () => {
      const sample = [
        "file_read",
        "file_write",
        "shell",
        "web_fetch",
        "memory_write",
        "schedule_task",
        "subagent_spawn",
      ];
      for (const name of sample) {
        expect(isOwnerOnlyToolName(name)).toBe(false);
      }
    });

    it("isOwnerOnlyToolName returns false for unknown names", () => {
      expect(isOwnerOnlyToolName("not_a_tool")).toBe(false);
      expect(isOwnerOnlyToolName("")).toBe(false);
    });
  });

  describe("ALLOWED_OWNER_TOOL_CONFIG_PATHS", () => {
    it("ships empty — no agent-facing config-write tool exists yet", () => {
      expect(ALLOWED_OWNER_TOOL_CONFIG_PATHS).toEqual([]);
    });

    it("isAllowedOwnerToolConfigPath rejects everything by default", () => {
      expect(isAllowedOwnerToolConfigPath("agents.defaults.model")).toBe(false);
      expect(isAllowedOwnerToolConfigPath("gateway.auth.token")).toBe(false);
      expect(isAllowedOwnerToolConfigPath("anything")).toBe(false);
    });
  });

  describe("assertOwnerOnlyAccess", () => {
    // Precondition: caller has already determined the tool is owner-gated.
    // This helper just enforces the role check.
    it("returns void for owner role", () => {
      expect(() =>
        assertOwnerOnlyAccess({ toolName: "anything", callerRole: "owner" }),
      ).not.toThrow();
    });

    it("throws EffectDeniedError for shell role", () => {
      expect(() =>
        assertOwnerOnlyAccess({ toolName: "config_set", callerRole: "shell" }),
      ).toThrow(/owner-only.*'shell'/);
    });

    it("throws EffectDeniedError for external role", () => {
      expect(() =>
        assertOwnerOnlyAccess({ toolName: "config_set", callerRole: "external" }),
      ).toThrow(/owner-only.*'external'/);
    });

    it("error message includes both the tool name and the role for forensics", () => {
      try {
        assertOwnerOnlyAccess({ toolName: "config_set", callerRole: "shell" });
        throw new Error("should not reach");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("config_set");
        expect(msg).toContain("shell");
      }
    });
  });
});

/**
 * Integration coverage for the full deny path runs in owner-only-routing.test.ts
 * (catalog filtering + validate-time gate + audit log entry shape). That suite
 * vi.mocks OWNER_ONLY_TOOL_NAMES with a fixture name so it can exercise the
 * non-empty branch without polluting the production set.
 */
