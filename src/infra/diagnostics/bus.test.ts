import { describe, expect, it, vi } from "vitest";
import { createDiagnosticBus } from "./bus.js";
import type { DiagnosticEventPayload } from "./events.js";

describe("createDiagnosticBus", () => {
  it("emits with stamped ts and monotonic seq", () => {
    const bus = createDiagnosticBus();
    const captured: DiagnosticEventPayload[] = [];
    bus.subscribe((event) => captured.push(event));

    const before = Date.now();
    bus.emit("tool.execution.started", { toolName: "echo" });
    bus.emit("tool.execution.completed", { toolName: "echo", durationMs: 5 });
    const after = Date.now();

    expect(captured).toHaveLength(2);
    expect(captured[0]!.seq).toBe(0);
    expect(captured[1]!.seq).toBe(1);
    expect(captured[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(captured[1]!.ts).toBeLessThanOrEqual(after);
    expect(captured[0]!.type).toBe("tool.execution.started");
    expect(captured[1]!.type).toBe("tool.execution.completed");
  });

  it("returns an unsubscribe function that stops delivery", () => {
    const bus = createDiagnosticBus();
    const handler = vi.fn();
    const off = bus.subscribe(handler);

    bus.emit("memory.sample", {
      memory: {
        rssBytes: 1,
        heapTotalBytes: 1,
        heapUsedBytes: 1,
        externalBytes: 0,
        arrayBuffersBytes: 0,
      },
    });
    off();
    bus.emit("memory.sample", {
      memory: {
        rssBytes: 2,
        heapTotalBytes: 2,
        heapUsedBytes: 2,
        externalBytes: 0,
        arrayBuffersBytes: 0,
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("subscribeOf narrows by event type", () => {
    const bus = createDiagnosticBus();
    const tool: DiagnosticEventPayload[] = [];
    const memory: DiagnosticEventPayload[] = [];

    bus.subscribeOf("tool.execution.completed", (e) => tool.push(e));
    bus.subscribeOf("memory.sample", (e) => memory.push(e));

    bus.emit("tool.execution.completed", { toolName: "x", durationMs: 1 });
    bus.emit("memory.sample", {
      memory: {
        rssBytes: 1,
        heapTotalBytes: 1,
        heapUsedBytes: 1,
        externalBytes: 0,
        arrayBuffersBytes: 0,
      },
    });
    bus.emit("tool.execution.error", {
      toolName: "x",
      durationMs: 1,
      errorCategory: "X",
    });

    expect(tool).toHaveLength(1);
    expect(memory).toHaveLength(1);
  });

  it("isolates a misbehaving subscriber from siblings", () => {
    const bus = createDiagnosticBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(good);

    expect(() =>
      bus.emit("tool.execution.completed", { toolName: "y", durationMs: 1 }),
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("is a no-op aside from stamping when there are zero subscribers", () => {
    const bus = createDiagnosticBus();
    expect(bus.subscriberCount).toBe(0);
    expect(() =>
      bus.emit("tool.execution.completed", { toolName: "z", durationMs: 1 }),
    ).not.toThrow();
  });

  it("reset() drops all subscribers and resets the seq counter", () => {
    const bus = createDiagnosticBus();
    const handler = vi.fn();
    bus.subscribe(handler);
    bus.emit("tool.execution.started", { toolName: "a" });
    bus.reset();
    expect(bus.subscriberCount).toBe(0);

    const captured: DiagnosticEventPayload[] = [];
    bus.subscribe((event) => captured.push(event));
    bus.emit("tool.execution.started", { toolName: "b" });
    expect(captured[0]!.seq).toBe(0);
  });
});

describe("redaction invariants on emitted payloads", () => {
  // Defense-in-depth check: walk every emitted event and confirm no
  // field name suggesting payload content slipped in. The contract type
  // already shapes this, but a future contract-relaxer change could
  // sneak a body/content field past review without breaking the build.
  it("rejects event field names that look like content carriers", () => {
    const bus = createDiagnosticBus();
    const captured: DiagnosticEventPayload[] = [];
    bus.subscribe((event) => captured.push(event));

    bus.emit("tool.execution.started", { toolName: "x" });
    bus.emit("tool.execution.completed", { toolName: "x", durationMs: 1 });
    bus.emit("tool.execution.error", {
      toolName: "x",
      durationMs: 1,
      errorCategory: "Boom",
    });
    bus.emit("exec.process.completed", {
      target: "host",
      outcome: "completed",
      durationMs: 1,
      commandLength: 16,
      exitCode: 0,
    });
    bus.emit("model.call.completed", {
      callId: "c",
      provider: "anthropic",
      model: "claude",
      durationMs: 1,
    });
    bus.emit("message.delivery.completed", {
      channel: "email-imap",
      deliveryKind: "text",
      durationMs: 1,
    });
    bus.emit("audit.recorded", {
      auditSeq: 0,
      toolId: "t",
      toolName: "n",
      effectClass: "info",
      resultStatus: "success",
      durationMs: 1,
    });

    const banned = /^(body|content|text|payload|data|message|prompt|response|stdout|stderr|command|cmd|args)$/i;
    for (const event of captured) {
      const walk = (v: unknown): void => {
        if (v === null || typeof v !== "object") return;
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          expect(banned.test(k)).toBe(false);
          walk(val);
        }
      };
      walk(event);
    }
  });
});
