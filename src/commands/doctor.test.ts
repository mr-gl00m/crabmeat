/**
 * Doctor diagnostics tests — focused on the audit-health surface added
 * in Phase 4.13.4. Other doctor checks (providers, sessions, etc.)
 * exercise the live config / pipeline surfaces and are covered by
 * integration tests; this file targets just the audit pathway.
 */

import { describe, it, expect, vi } from "vitest";
import { checkAuditHealth, checkReleaseGate } from "./doctor.js";
import type { CommandContext } from "./registry.js";
import type { AuditLog, AuditStatus } from "../security/audit.js";
import type { Config } from "../config/types.js";
import { configSchema } from "../config/schema.js";

function makeCtx(status: AuditStatus): CommandContext {
  const auditLog: AuditLog = {
    record: vi.fn(),
    verify: vi.fn(() => ({ valid: true })),
    getEntries: vi.fn(() => []),
    flush: vi.fn(async () => {}),
    getStatus: vi.fn(() => status),
    length: status.totalEntries,
  } as unknown as AuditLog;

  return {
    pipeline: { auditLog } as unknown as CommandContext["pipeline"],
  } as CommandContext;
}

describe("checkAuditHealth", () => {
  it("returns ok when persist is disabled (in-memory mode is intentional)", () => {
    const ctx = makeCtx({
      persistEnabled: false,
      pendingWrites: 0,
      totalEntries: 5,
      lastFlushAt: null,
      lastFlushOk: null,
      lastFlushError: null,
    });
    const results = checkAuditHealth(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.message).toContain("in-memory");
  });

  it("returns error when the last flush failed", () => {
    const ctx = makeCtx({
      persistEnabled: true,
      pendingWrites: 12,
      totalEntries: 100,
      lastFlushAt: "2026-04-29T01:00:00.000Z",
      lastFlushOk: false,
      lastFlushError: "ENOSPC: no space left on device",
    });
    const results = checkAuditHealth(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.message).toContain("last flush failed");
    expect(results[0]!.message).toContain("ENOSPC");
    // Operator must see when this happened.
    expect(results[0]!.message).toContain("2026-04-29T01:00:00.000Z");
  });

  it("returns warn when pendingWrites is high (queue building up)", () => {
    const ctx = makeCtx({
      persistEnabled: true,
      pendingWrites: 60,
      totalEntries: 200,
      lastFlushAt: "2026-04-29T01:00:00.000Z",
      lastFlushOk: true,
      lastFlushError: null,
    });
    const results = checkAuditHealth(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("warn");
    expect(results[0]!.message).toContain("60 entries queued");
  });

  it("returns ok at cold start (persist enabled but no flush attempted yet)", () => {
    const ctx = makeCtx({
      persistEnabled: true,
      pendingWrites: 3,
      totalEntries: 3,
      lastFlushAt: null,
      lastFlushOk: null,
      lastFlushError: null,
    });
    const results = checkAuditHealth(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.message).toContain("cold start");
  });

  it("returns ok healthy on the steady-state success path", () => {
    const ctx = makeCtx({
      persistEnabled: true,
      pendingWrites: 4,
      totalEntries: 1500,
      lastFlushAt: "2026-04-29T01:30:00.000Z",
      lastFlushOk: true,
      lastFlushError: null,
    });
    const results = checkAuditHealth(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.message).toContain("persist healthy");
    expect(results[0]!.message).toContain("1500 entries");
  });

  // Phase 4.18.2 — release-gate-specific assertions.
  it("returns empty results when getStatus is unavailable on the audit log (older pipeline)", () => {
    const ctx = {
      pipeline: {
        auditLog: {
          record: vi.fn(),
          verify: vi.fn(() => ({ valid: true })),
          getEntries: vi.fn(() => []),
          flush: vi.fn(async () => {}),
          length: 0,
          // Deliberately no getStatus.
        } as unknown as AuditLog,
      } as unknown as CommandContext["pipeline"],
    } as CommandContext;

    const results = checkAuditHealth(ctx);
    expect(results).toEqual([]);
  });
});

describe("checkReleaseGate (Phase 4.18.2)", () => {
  function baseConfig(): Config {
    return configSchema.parse({
      gateway: {
        auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" },
      },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
    });
  }

  it("returns no findings on a sane release-ready config", () => {
    const findings = checkReleaseGate(baseConfig());
    expect(findings).toEqual([]);
  });

  it("flags auth.mode='none' as a release-blocker error", () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "none" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
    });
    const findings = checkReleaseGate(cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("error");
    expect(findings[0]!.message).toMatch(/auth\.mode='none'/);
  });

  it("flags non-loopback bind without TLS as a release-blocker error", () => {
    const cfg = configSchema.parse({
      gateway: {
        host: "0.0.0.0",
        auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" },
      },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
    });
    const findings = checkReleaseGate(cfg);
    const hostFindings = findings.filter((f) => f.label.includes("Gateway host"));
    expect(hostFindings).toHaveLength(1);
    expect(hostFindings[0]!.status).toBe("error");
    expect(hostFindings[0]!.message).toMatch(/non-loopback/);
  });

  it("does NOT flag a non-loopback bind when TLS is configured", () => {
    const cfg = configSchema.parse({
      gateway: {
        host: "0.0.0.0",
        auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" },
        tls: { cert: "/etc/cert.pem", key: "/etc/key.pem" },
      },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
    });
    const findings = checkReleaseGate(cfg);
    expect(findings.filter((f) => f.label.includes("Gateway host"))).toEqual([]);
  });

  it("flags admin enabled with external connectors but no publicBaseUrl", () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      admin: { enabled: true, token: "x".repeat(32) },
      connectors: {
        emailImap: {
          user: "agent@example.com",
          password: "abcdefghijklmnop",
          allowFromAddresses: ["owner@example.com"],
        },
      },
    });
    const findings = checkReleaseGate(cfg);
    const adminFindings = findings.filter((f) => f.label.includes("publicBaseUrl"));
    expect(adminFindings).toHaveLength(1);
    expect(adminFindings[0]!.status).toBe("error");
    expect(adminFindings[0]!.message).toMatch(/kill-link/);
  });

  it("does NOT flag admin enabled with publicBaseUrl set", () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      admin: {
        enabled: true,
        token: "x".repeat(32),
        publicBaseUrl: "https://crabmeat.example.com",
      },
      connectors: {
        emailImap: {
          user: "agent@example.com",
          password: "abcdefghijklmnop",
          allowFromAddresses: ["owner@example.com"],
        },
      },
    });
    const findings = checkReleaseGate(cfg);
    expect(findings.filter((f) => f.label.includes("publicBaseUrl"))).toEqual([]);
  });

  it("flags webhooks enabled with requireSecret=false as a release-blocker", () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      webhooks: { enabled: true, requireSecret: false },
    });
    const findings = checkReleaseGate(cfg);
    const webhookFindings = findings.filter((f) => f.label.includes("Webhooks"));
    expect(webhookFindings).toHaveLength(1);
    expect(webhookFindings[0]!.status).toBe("error");
    expect(webhookFindings[0]!.message).toMatch(/unauthenticated/);
  });

  it("does NOT flag webhooks when requireSecret stays true (default)", () => {
    const cfg = configSchema.parse({
      gateway: { auth: { mode: "token", token: "a]3kF!9xR#mL2wQ$vN7yT&pZc8dG0hJ5" } },
      providers: [{ id: "openai", type: "openai", apiKey: "sk-x", model: "m" }],
      webhooks: { enabled: true },
    });
    const findings = checkReleaseGate(cfg);
    expect(findings.filter((f) => f.label.includes("Webhooks"))).toEqual([]);
  });
});
