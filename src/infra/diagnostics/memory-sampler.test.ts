import { describe, expect, it, vi } from "vitest";
import { createMemorySampler } from "./memory-sampler.js";
import { diagnostics } from "./bus.js";
import type { DiagnosticEventPayload } from "./events.js";

function withCapturedEvents(run: (events: DiagnosticEventPayload[]) => void): void {
  diagnostics.reset();
  const captured: DiagnosticEventPayload[] = [];
  const off = diagnostics.subscribe((event) => captured.push(event));
  try {
    run(captured);
  } finally {
    off();
    diagnostics.reset();
  }
}

describe("createMemorySampler", () => {
  it("emits a memory.sample event on sampleNow", () => {
    withCapturedEvents((events) => {
      const sampler = createMemorySampler();
      sampler.sampleNow();
      sampler.stop();

      const samples = events.filter((e) => e.type === "memory.sample");
      expect(samples).toHaveLength(1);
      const sample = samples[0] as Extract<DiagnosticEventPayload, { type: "memory.sample" }>;
      expect(sample.memory.rssBytes).toBeGreaterThan(0);
      expect(sample.memory.heapUsedBytes).toBeGreaterThan(0);
      expect(typeof sample.uptimeMs).toBe("number");
    });
  });

  it("emits memory.pressure at critical when RSS crosses the critical threshold", () => {
    withCapturedEvents((events) => {
      // Set thresholds far below current process RSS so the sample
      // immediately triggers pressure.
      const sampler = createMemorySampler({
        rssWarnBytes: 1,
        rssCriticalBytes: 2,
      });
      sampler.sampleNow();
      sampler.stop();

      const pressure = events.find((e) => e.type === "memory.pressure");
      expect(pressure).toBeDefined();
      const p = pressure as Extract<DiagnosticEventPayload, { type: "memory.pressure" }>;
      expect(p.level).toBe("critical");
      expect(p.reason).toBe("rss_threshold");
    });
  });

  it("emits memory.pressure at warning when only the warn threshold is crossed", () => {
    withCapturedEvents((events) => {
      const sampler = createMemorySampler({
        rssWarnBytes: 1,
        // Set critical impossibly high so we land in the warning bucket.
        rssCriticalBytes: Number.MAX_SAFE_INTEGER,
      });
      sampler.sampleNow();
      sampler.stop();

      const pressure = events.find((e) => e.type === "memory.pressure");
      expect(pressure).toBeDefined();
      const p = pressure as Extract<DiagnosticEventPayload, { type: "memory.pressure" }>;
      expect(p.level).toBe("warning");
      expect(p.reason).toBe("rss_threshold");
    });
  });

  it("does not emit pressure when readings stay under all thresholds", () => {
    withCapturedEvents((events) => {
      const sampler = createMemorySampler({
        rssWarnBytes: Number.MAX_SAFE_INTEGER,
        rssCriticalBytes: Number.MAX_SAFE_INTEGER,
        heapWarnBytes: Number.MAX_SAFE_INTEGER,
        growthThresholdBytes: Number.MAX_SAFE_INTEGER,
      });
      sampler.sampleNow();
      sampler.stop();

      const pressure = events.find((e) => e.type === "memory.pressure");
      expect(pressure).toBeUndefined();
    });
  });

  it("start/stop manages a single interval timer", () => {
    vi.useFakeTimers();
    try {
      withCapturedEvents((events) => {
        const sampler = createMemorySampler({ intervalMs: 1000 });
        sampler.start();
        sampler.start(); // idempotent — should not stack timers
        vi.advanceTimersByTime(2500);
        sampler.stop();
        sampler.stop(); // idempotent

        const samples = events.filter((e) => e.type === "memory.sample");
        // 1000ms intervals over 2500ms should produce 2 samples (at t=1000 and t=2000)
        expect(samples.length).toBe(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
