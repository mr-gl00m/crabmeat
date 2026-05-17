import { describe, expect, it } from "vitest";
import { attributesFromEvent, createOtelExporter } from "./otel-exporter.js";
import { createDiagnosticBus } from "./bus.js";
import type { DiagnosticEventPayload } from "./events.js";

describe("attributesFromEvent — redaction at export boundary", () => {
  it("strips identifier fields (sessionKey, callId, runId, toolCallId, sessionId, auditSeq)", () => {
    const event: DiagnosticEventPayload = {
      type: "model.call.completed",
      ts: 1_000_000,
      seq: 5,
      callId: "call-DO-NOT-LEAK",
      runId: "run-DO-NOT-LEAK",
      sessionKey: "sk-DO-NOT-LEAK",
      sessionId: "sid-DO-NOT-LEAK",
      provider: "anthropic",
      model: "claude-opus",
      durationMs: 1234,
    };
    const attrs = attributesFromEvent(event);
    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain("DO-NOT-LEAK");
    expect(serialized).not.toContain("sessionKey");
    expect(serialized).not.toContain("callId");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("toolCallId");
    expect(serialized).not.toContain("sessionId");
  });

  it("strips bus-internal envelope fields (ts, seq, type, trace)", () => {
    const event: DiagnosticEventPayload = {
      type: "tool.execution.completed",
      ts: 1_000_000,
      seq: 42,
      trace: { traceId: "t".repeat(32), spanId: "s".repeat(16) },
      toolName: "echo",
      durationMs: 5,
    };
    const attrs = attributesFromEvent(event);
    expect(attrs).not.toHaveProperty("crabmeat.ts");
    expect(attrs).not.toHaveProperty("crabmeat.seq");
    expect(attrs).not.toHaveProperty("crabmeat.type");
    expect(attrs).not.toHaveProperty("crabmeat.trace");
  });

  it("rejects strings that fail the low-cardinality charset/length check", () => {
    const event: DiagnosticEventPayload = {
      type: "tool.execution.error",
      ts: 1_000_000,
      seq: 1,
      toolName: "valid_tool-name",
      durationMs: 1,
      // Spaces and punctuation fall outside the low-cardinality regex.
      errorCategory: "Some long error message with spaces and punctuation!",
    };
    const attrs = attributesFromEvent(event);
    expect(attrs["crabmeat.toolName"]).toBe("valid_tool-name");
    expect(attrs).not.toHaveProperty("crabmeat.errorCategory");
  });

  it("preserves bounded numeric and boolean fields", () => {
    const event: DiagnosticEventPayload = {
      type: "exec.process.completed",
      ts: 1_000_000,
      seq: 1,
      target: "host",
      outcome: "completed",
      durationMs: 250,
      commandLength: 64,
      exitCode: 0,
      timedOut: false,
    };
    const attrs = attributesFromEvent(event);
    expect(attrs["crabmeat.durationMs"]).toBe(250);
    expect(attrs["crabmeat.commandLength"]).toBe(64);
    expect(attrs["crabmeat.exitCode"]).toBe(0);
    expect(attrs["crabmeat.timedOut"]).toBe(false);
  });

  it("strips nested object fields (memory, usage) — those are expanded into separate instruments", () => {
    const event: DiagnosticEventPayload = {
      type: "memory.sample",
      ts: 1_000_000,
      seq: 1,
      memory: {
        rssBytes: 1024,
        heapTotalBytes: 512,
        heapUsedBytes: 256,
        externalBytes: 64,
        arrayBuffersBytes: 32,
      },
      uptimeMs: 60_000,
    };
    const attrs = attributesFromEvent(event);
    expect(attrs).not.toHaveProperty("crabmeat.memory");
    // uptimeMs is a flat number — it survives.
    expect(attrs["crabmeat.uptimeMs"]).toBe(60_000);
  });
});

describe("createOtelExporter — bootstrap rules", () => {
  it("returns null when no endpoint is configured anywhere", async () => {
    // Snapshot env so we can clean up after.
    const saved = {
      preloaded: process.env.CRABMEAT_OTEL_PRELOADED,
      base: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      traces: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      metrics: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    };
    delete process.env.CRABMEAT_OTEL_PRELOADED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    try {
      const bus = createDiagnosticBus();
      const exporter = await createOtelExporter(bus);
      expect(exporter).toBeNull();
    } finally {
      if (saved.preloaded !== undefined) process.env.CRABMEAT_OTEL_PRELOADED = saved.preloaded;
      if (saved.base !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved.base;
      if (saved.traces !== undefined) process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = saved.traces;
      if (saved.metrics !== undefined) process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = saved.metrics;
    }
  });

  it("does not subscribe to the bus when returning null", async () => {
    const bus = createDiagnosticBus();
    const before = bus.subscriberCount;
    const exporter = await createOtelExporter(bus);
    expect(exporter).toBeNull();
    expect(bus.subscriberCount).toBe(before);
  });

  // RT-2026-05-01-007 hybrid: the SDK + exporter packages are now
  // optionalDependencies. With them installed (current dev state) the bootstrap
  // succeeds against a non-routable endpoint; this test pins the contract that
  // "endpoint configured + SDK present" returns a working exporter rather than
  // null. The matching soft-fail-on-missing path is exercised manually via the
  // cold-VM install with --omit=optional.
  it("returns a working exporter when an endpoint is set and SDK is available", async () => {
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:65535";
    try {
      const bus = createDiagnosticBus();
      const exporter = await createOtelExporter(bus);
      expect(exporter).not.toBeNull();
      await exporter?.shutdown();
    } finally {
      if (saved !== undefined) {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
      } else {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      }
    }
  });
});
