/**
 * Periodic process memory sampler.
 *
 * Emits `memory.sample` at a fixed interval and `memory.pressure` when
 * RSS or heap-used crosses a configured threshold, or when RSS grows
 * by more than `growthThresholdBytes` over `growthWindowMs`. This is
 * a coarse-grained leak-detection canary, not a profiler.
 *
 * Usage:
 *   const sampler = createMemorySampler();
 *   sampler.start();
 *   // … later
 *   sampler.stop();
 *
 * Defaults are conservative for a long-running single-user agent. Tune
 * via createMemorySampler({ ... }) when calling from entry.ts.
 */

import { diagnostics } from "./bus.js";
import type { DiagnosticMemoryUsage } from "./events.js";

export interface MemorySamplerOptions {
  /** Sample interval in ms. Default 60_000 (1 min). */
  intervalMs?: number;
  /** RSS threshold in bytes that flips state to "warning". Default 768 MiB. */
  rssWarnBytes?: number;
  /** RSS threshold in bytes that flips state to "critical". Default 1.5 GiB. */
  rssCriticalBytes?: number;
  /** Heap-used threshold in bytes that flips state to "warning". Default 384 MiB. */
  heapWarnBytes?: number;
  /** RSS growth-rate detection: bytes added across the window. Default 256 MiB. */
  growthThresholdBytes?: number;
  /** Window over which to evaluate growth. Default 10 min. */
  growthWindowMs?: number;
}

const DEFAULTS: Required<MemorySamplerOptions> = {
  intervalMs: 60_000,
  rssWarnBytes: 768 * 1024 * 1024,
  rssCriticalBytes: 1536 * 1024 * 1024,
  heapWarnBytes: 384 * 1024 * 1024,
  growthThresholdBytes: 256 * 1024 * 1024,
  growthWindowMs: 10 * 60_000,
};

export interface MemorySampler {
  start(): void;
  stop(): void;
  /** Take a sample now and emit. Useful for tests. */
  sampleNow(): void;
}

function readUsage(): DiagnosticMemoryUsage {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapTotalBytes: m.heapTotal,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers,
  };
}

export function createMemorySampler(opts: MemorySamplerOptions = {}): MemorySampler {
  const cfg = { ...DEFAULTS, ...opts };
  let timer: ReturnType<typeof setInterval> | undefined;
  // Sliding window of (ts, rss) for growth detection.
  const history: Array<{ ts: number; rss: number }> = [];

  function evaluatePressure(usage: DiagnosticMemoryUsage, now: number): void {
    // Threshold checks — fire critical first so a single sample can't
    // be both warning and critical.
    if (usage.rssBytes >= cfg.rssCriticalBytes) {
      diagnostics.emit("memory.pressure", {
        level: "critical",
        reason: "rss_threshold",
        memory: usage,
        thresholdBytes: cfg.rssCriticalBytes,
      });
      return;
    }
    if (usage.rssBytes >= cfg.rssWarnBytes) {
      diagnostics.emit("memory.pressure", {
        level: "warning",
        reason: "rss_threshold",
        memory: usage,
        thresholdBytes: cfg.rssWarnBytes,
      });
      return;
    }
    if (usage.heapUsedBytes >= cfg.heapWarnBytes) {
      diagnostics.emit("memory.pressure", {
        level: "warning",
        reason: "heap_threshold",
        memory: usage,
        thresholdBytes: cfg.heapWarnBytes,
      });
      return;
    }

    // Growth detection over the configured window.
    const cutoff = now - cfg.growthWindowMs;
    while (history.length > 0 && history[0]!.ts < cutoff) history.shift();
    if (history.length > 0) {
      const oldest = history[0]!;
      const grew = usage.rssBytes - oldest.rss;
      if (grew >= cfg.growthThresholdBytes) {
        diagnostics.emit("memory.pressure", {
          level: "warning",
          reason: "rss_growth",
          memory: usage,
          rssGrowthBytes: grew,
          windowMs: now - oldest.ts,
        });
      }
    }
  }

  function tick(): void {
    const now = Date.now();
    const usage = readUsage();
    history.push({ ts: now, rss: usage.rssBytes });
    diagnostics.emit("memory.sample", {
      memory: usage,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    evaluatePressure(usage, now);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, cfg.intervalMs);
      // Don't pin the event loop — the agent should exit cleanly even
      // if nothing else has a chance to call stop().
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      history.length = 0;
    },
    sampleNow() {
      tick();
    },
  };
}
