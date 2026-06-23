import { describe, it, expect, vi } from "vitest";
import { executeValidatedTool } from "./invoke.js";
import type { ValidatedInvocation, ToolExecuteHandler } from "./types.js";
import type { SecretStore } from "./secrets.js";

function makeInvocation(overrides: Partial<ValidatedInvocation> = {}): ValidatedInvocation {
  return {
    toolId: "test-tool",
    toolName: "test_tool",
    callId: "call-1",
    parameters: {},
    effectClass: "read",
    ...overrides,
  };
}

function makeSecretStore(secrets: Record<string, string> = {}): SecretStore {
  return {
    resolve(name) {
      return secrets[name];
    },
  };
}

describe("executeValidatedTool", () => {
  it("executes handler and wraps result in TOOL_RESULT tag", async () => {
    const handler: ToolExecuteHandler = async () => ({
      content: "Hello from tool",
    });

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^<TOOL_RESULT type="untrusted" tool="test_tool" timestamp="\d{4}-\d{2}-\d{2}T[\d:.]+Z">/m);
    expect(result.content).toContain("Hello from tool");
    expect(result.content).toContain("</TOOL_RESULT>");
  });

  it("passes validated parameters to handler", async () => {
    const handler = vi.fn(async (params) => ({
      content: `Got: ${params.query}`,
    }));

    await executeValidatedTool(
      makeInvocation({ parameters: { query: "test search" } }),
      handler,
      makeSecretStore(),
    );

    expect(handler).toHaveBeenCalledWith({ query: "test search" }, expect.any(AbortSignal), undefined);
  });

  it("resolves $SECRET: references before execution", async () => {
    const handler = vi.fn(async (params) => ({
      content: `Token: ${params.token}`,
    }));

    await executeValidatedTool(
      makeInvocation({ parameters: { token: "$SECRET:GITHUB_TOKEN" } }),
      handler,
      makeSecretStore({ GITHUB_TOKEN: "ghp_realtoken123" }),
    );

    expect(handler).toHaveBeenCalledWith({ token: "ghp_realtoken123" }, expect.any(AbortSignal), undefined);
  });

  it("returns error when secret is not found", async () => {
    const handler = vi.fn(async () => ({ content: "ok" }));

    const result = await executeValidatedTool(
      makeInvocation({ parameters: { token: "$SECRET:MISSING_KEY" } }),
      handler,
      makeSecretStore({}),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Secret 'MISSING_KEY' not found");
    expect(handler).not.toHaveBeenCalled();
  });

  it("handles handler errors gracefully", async () => {
    const handler: ToolExecuteHandler = async () => {
      throw new Error("Tool crashed");
    };

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool crashed");
    expect(result.content).toContain("TOOL_RESULT");
  });

  it("wraps error results with status='error'", async () => {
    const handler: ToolExecuteHandler = async () => ({
      content: "something went wrong",
      isError: true,
    });

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('status="error"');
  });

  it("enforces timeout", async () => {
    const handler: ToolExecuteHandler = async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { content: "late" };
    };

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
      50, // 50ms timeout
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  it("preserves callId and toolId in result", async () => {
    const handler: ToolExecuteHandler = async () => ({
      content: "ok",
    });

    const result = await executeValidatedTool(
      makeInvocation({ toolId: "my-tool", callId: "call-42" }),
      handler,
      makeSecretStore(),
    );

    expect(result.toolId).toBe("my-tool");
    expect(result.callId).toBe("call-42");
  });

  it("redacts AWS keys in tool result before wrapping", async () => {
    const handler: ToolExecuteHandler = async () => ({
      content: "Found key: AKIAIOSFODNN7EXAMPLE in config",
    });

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).toContain("TOOL_RESULT");
  });

  it("redacts JWT tokens in tool result before wrapping", async () => {
    const handler: ToolExecuteHandler = async () => ({
      content: "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.content).not.toContain("eyJhbGciOiJ");
    expect(result.content).toContain("[REDACTED]");
  });

  it("redacts connection strings in error messages", async () => {
    const handler: ToolExecuteHandler = async () => {
      throw new Error("Failed to connect to postgres://admin:s3cret@prod-db:5432/main");
    };

    const result = await executeValidatedTool(
      makeInvocation(),
      handler,
      makeSecretStore(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("postgres://");
    expect(result.content).not.toContain("s3cret");
    expect(result.content).toContain("[REDACTED]");
  });
});
