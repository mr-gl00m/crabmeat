/**
 * OpenTelemetry exporter — a subscriber that translates DiagnosticEventPayload
 * events into OTEL spans, counters, and histograms.
 *
 * Boundary contract:
 *   - Identifier fields (sessionKey, sessionId, callId, runId, toolCallId,
 *     auditSeq) are STRIPPED before any attribute reaches OTEL. They live
 *     in the event for in-process correlation and pino bridging only.
 *     Dropping these keeps metric-label cardinality bounded — leaving
 *     them in would let the labels explode.
 *   - Provider/model names are bounded to ≤120 chars matching a low-card
 *     character class. Anything that fails the check is dropped silently.
 *   - No event payload content is forwarded — the event contract already
 *     enforces this; this layer is a second line of defense.
 *
 * Endpoint resolution order:
 *   1. CRABMEAT_OTEL_PRELOADED=1 → reuse externally-registered SDK,
 *      attach only the bus subscriber. Lets operators run their own
 *      OTEL bootstrap and have CrabMeat plug in.
 *   2. signalEndpoints.{traces,metrics} (config or matching env var)
 *   3. base endpoint (config or OTEL_EXPORTER_OTLP_ENDPOINT)
 *   4. None of the above → returns null. The bus is unaffected; events
 *      still flow to other subscribers (pino bridge, tests, etc.).
 *
 * GenAI semantic conventions follow the stable surface; the experimental
 * provider attribute (gen_ai.provider.name) is not emitted by default.
 */

import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api";

import type { DiagnosticBus } from "./bus.js";
import type { DiagnosticEventPayload } from "./events.js";

// RT-2026-05-01-007 (hybrid resolution): the OTEL SDK + exporter packages live
// in optionalDependencies. They are pulled in only when an endpoint is actually
// configured (or CRABMEAT_OTEL_PRELOADED=1), so an operator who installs with
// --omit=optional gets a working gateway with the exporter as a soft no-op.
// `@opentelemetry/api` stays in dependencies so the in-process tracer/meter
// surface keeps the no-op semantics callers already rely on.

// Minimal type shape we need from NodeSDK at the type level — the real symbol
// is dynamic-imported below. Avoids a top-level "import type" against the
// optional package path so callers compiling without it still typecheck.
interface OtelSdkLike {
  start(): void;
  shutdown(): Promise<void>;
}

const DEFAULT_SERVICE_NAME = "crabmeat";
const PRELOADED_ENV = "CRABMEAT_OTEL_PRELOADED";
const ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const TRACES_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const METRICS_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";

/** Identifier fields that never reach exported attributes. High-cardinality
 *  by design — they'd blow up metric label cardinality and span search indexes. */
const DROPPED_KEYS = new Set([
  "sessionKey",
  "sessionId",
  "callId",
  "runId",
  "toolCallId",
  "auditSeq",
  "ts",
  "seq",
  "type",
  "trace",
  "memory", // expanded into separate gauges below; not a span attribute
  "usage", // expanded into separate histograms; not a span attribute
]);

/** Low-cardinality value validator — bounds string attributes against a
 *  conservative charset and length cap. Strings that fail are dropped. */
const LOW_CARDINALITY_VALUE_RE = /^[A-Za-z0-9_.:\-/]{1,120}$/;

const GEN_AI_TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];
const GEN_AI_OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

export interface OtelExporterConfig {
  serviceName?: string;
  /** Base OTLP endpoint, used as fallback when no per-signal endpoint is set. */
  endpoint?: string;
  signalEndpoints?: {
    traces?: string;
    metrics?: string;
  };
  /** Trace sample rate, 0..1. Default: 1 (sample everything). */
  sampleRate?: number;
  /** Metric export interval in ms. Default: 60_000 (1 minute). */
  metricExportIntervalMs?: number;
}

export interface OtelExporter {
  shutdown(): Promise<void>;
}

/**
 * Convert a diagnostic event into a flat attribute bag suitable for OTEL.
 *
 * Exported for unit testing — the redaction invariant (no identifier
 * fields, no payload content) is what prevents an accidental attribute
 * regression from leaking sessionKey into a metric label.
 */
export function attributesFromEvent(event: DiagnosticEventPayload): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(event)) {
    if (DROPPED_KEYS.has(k)) continue;
    if (typeof v === "string") {
      if (LOW_CARDINALITY_VALUE_RE.test(v)) {
        out[`crabmeat.${k}`] = v;
      }
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[`crabmeat.${k}`] = v;
    } else if (typeof v === "boolean") {
      out[`crabmeat.${k}`] = v;
    }
  }
  return out;
}

function resolveEndpoint(
  signal: string | undefined,
  signalEnv: string | undefined,
  base: string | undefined,
  baseEnv: string | undefined,
): string | undefined {
  return (
    trim(signal) ?? trim(signalEnv) ?? trim(base) ?? trim(baseEnv) ?? undefined
  );
}

function trim(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

export async function createOtelExporter(
  bus: DiagnosticBus,
  config: OtelExporterConfig = {},
): Promise<OtelExporter | null> {
  const preloaded = process.env[PRELOADED_ENV] === "1";
  const tracesEndpoint = resolveEndpoint(
    config.signalEndpoints?.traces,
    process.env[TRACES_ENDPOINT_ENV],
    config.endpoint,
    process.env[ENDPOINT_ENV],
  );
  const metricsEndpoint = resolveEndpoint(
    config.signalEndpoints?.metrics,
    process.env[METRICS_ENDPOINT_ENV],
    config.endpoint,
    process.env[ENDPOINT_ENV],
  );

  // Silent no-op: nothing configured, nothing to export. Critically this path
  // runs without ever touching the optional SDK packages, so an operator who
  // installed with --omit=optional gets a clean boot.
  if (!preloaded && !tracesEndpoint && !metricsEndpoint) {
    return null;
  }

  let sdk: OtelSdkLike | undefined;
  if (!preloaded) {
    let sdkMods;
    try {
      sdkMods = await loadOptionalSdkModules();
    } catch {
      // The optional packages are not installed but the operator did configure
      // an endpoint. Fail soft — the gateway should not crash because OTEL is
      // missing. Emit a single bus event so the observability layer (pino
      // bridge, etc.) can record the degraded state. We do not forward the
      // upstream error text (low-cardinality contract on telemetry events).
      bus.emit("telemetry.exporter", {
        exporter: "otlp",
        signal: tracesEndpoint ? "traces" : "metrics",
        state: "failed",
        errorCategory: "optional_sdk_missing",
      });
      return null;
    }
    const {
      OTLPMetricExporter,
      OTLPTraceExporter,
      resourceFromAttributes,
      PeriodicExportingMetricReader,
      NodeSDK,
      ParentBasedSampler,
      TraceIdRatioBasedSampler,
      ATTR_SERVICE_NAME,
    } = sdkMods;
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName ?? DEFAULT_SERVICE_NAME,
    });
    const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = { resource };
    if (config.sampleRate !== undefined && config.sampleRate >= 0 && config.sampleRate <= 1) {
      sdkConfig.sampler = new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.sampleRate),
      });
    }
    if (tracesEndpoint) {
      sdkConfig.traceExporter = new OTLPTraceExporter({ url: tracesEndpoint });
    }
    if (metricsEndpoint) {
      sdkConfig.metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
        exportIntervalMillis: config.metricExportIntervalMs ?? 60_000,
      });
    }
    sdk = new NodeSDK(sdkConfig);
    sdk.start();
  }

  const tracer = trace.getTracer("crabmeat");
  const meter = metrics.getMeter("crabmeat");

  const tokenUsageHistogram = meter.createHistogram(
    "gen_ai.client.token.usage",
    { advice: { explicitBucketBoundaries: GEN_AI_TOKEN_USAGE_BUCKETS } },
  );
  const operationDurationHistogram = meter.createHistogram(
    "gen_ai.client.operation.duration",
    {
      unit: "s",
      advice: { explicitBucketBoundaries: GEN_AI_OPERATION_DURATION_BUCKETS },
    },
  );
  const toolLoopCounter = meter.createCounter("crabmeat.tool.loop.count");
  const auditCounter = meter.createCounter("crabmeat.audit.recorded.count");
  const memoryPressureCounter = meter.createCounter(
    "crabmeat.memory.pressure.count",
  );
  const memoryRssHistogram = meter.createHistogram("crabmeat.memory.rss", {
    unit: "By",
  });
  const memoryHeapHistogram = meter.createHistogram("crabmeat.memory.heap_used", {
    unit: "By",
  });
  const messageDeliveryDuration = meter.createHistogram(
    "crabmeat.message.delivery.duration",
    { unit: "ms" },
  );
  const toolExecDuration = meter.createHistogram(
    "crabmeat.tool.execution.duration",
    { unit: "ms" },
  );
  const execProcessDuration = meter.createHistogram(
    "crabmeat.exec.process.duration",
    { unit: "ms" },
  );

  const off = bus.subscribe((event) => handleEvent(event));

  function handleEvent(event: DiagnosticEventPayload): void {
    const attrs = attributesFromEvent(event);
    switch (event.type) {
      case "tool.execution.completed":
      case "tool.execution.error": {
        const startTime = event.ts - event.durationMs;
        const span = tracer.startSpan("crabmeat.tool", {
          startTime: new Date(startTime),
          attributes: attrs,
        });
        if (event.type === "tool.execution.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.errorCategory,
          });
        }
        span.end(new Date(event.ts));
        toolExecDuration.record(event.durationMs, attrs);
        break;
      }
      case "tool.execution.started":
        // No-op — completed/error spans wrap the duration directly.
        break;
      case "context.assembled": {
        const span = tracer.startSpan("crabmeat.context.assembled", {
          attributes: attrs,
        });
        span.end();
        break;
      }
      case "model.call.completed":
      case "model.call.error": {
        const startTime = event.ts - event.durationMs;
        const genAiAttrs: Attributes = { ...attrs };
        if (LOW_CARDINALITY_VALUE_RE.test(event.provider)) {
          genAiAttrs["gen_ai.system"] = event.provider;
        }
        if (LOW_CARDINALITY_VALUE_RE.test(event.model)) {
          genAiAttrs["gen_ai.request.model"] = event.model;
        }
        const span = tracer.startSpan("crabmeat.model.call", {
          startTime: new Date(startTime),
          attributes: genAiAttrs,
        });
        if (event.type === "model.call.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.errorCategory,
          });
        }
        span.end(new Date(event.ts));
        operationDurationHistogram.record(event.durationMs / 1000, genAiAttrs);
        if (event.type === "model.call.completed" && event.usage) {
          const u = event.usage;
          if (typeof u.input === "number") {
            tokenUsageHistogram.record(u.input, {
              ...genAiAttrs,
              "gen_ai.token.type": "input",
            });
          }
          if (typeof u.output === "number") {
            tokenUsageHistogram.record(u.output, {
              ...genAiAttrs,
              "gen_ai.token.type": "output",
            });
          }
        }
        break;
      }
      case "message.delivery.completed":
      case "message.delivery.error": {
        const startTime = event.ts - event.durationMs;
        const span = tracer.startSpan("crabmeat.message.delivery", {
          startTime: new Date(startTime),
          attributes: attrs,
        });
        if (event.type === "message.delivery.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.errorCategory,
          });
        }
        span.end(new Date(event.ts));
        messageDeliveryDuration.record(event.durationMs, attrs);
        break;
      }
      case "message.delivery.started":
        break; // span and histogram emitted at completion
      case "tool.loop":
        toolLoopCounter.add(1, attrs);
        break;
      case "exec.process.completed": {
        const startTime = event.ts - event.durationMs;
        const span = tracer.startSpan("crabmeat.exec", {
          startTime: new Date(startTime),
          attributes: attrs,
        });
        if (event.outcome === "failed") {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end(new Date(event.ts));
        execProcessDuration.record(event.durationMs, attrs);
        break;
      }
      case "audit.recorded":
        auditCounter.add(1, attrs);
        break;
      case "memory.sample":
        memoryRssHistogram.record(event.memory.rssBytes);
        memoryHeapHistogram.record(event.memory.heapUsedBytes);
        break;
      case "memory.pressure":
        memoryPressureCounter.add(1, attrs);
        break;
      case "telemetry.exporter":
        // Self-instrumentation event; the OTEL pipeline already reports
        // its own export failures via internal SDK telemetry.
        break;
    }
  }

  return {
    async shutdown() {
      off();
      if (sdk) {
        await sdk.shutdown();
      }
    },
  };
}

// Lazy import of every optional OTEL package the SDK bootstrap needs. Wrapped
// in a single helper so an install without the optional deps surfaces as one
// MODULE_NOT_FOUND for the caller to soft-fail on, rather than a sequence of
// scattered import errors.
async function loadOptionalSdkModules(): Promise<{
  OTLPMetricExporter: typeof import("@opentelemetry/exporter-metrics-otlp-proto").OTLPMetricExporter;
  OTLPTraceExporter: typeof import("@opentelemetry/exporter-trace-otlp-proto").OTLPTraceExporter;
  resourceFromAttributes: typeof import("@opentelemetry/resources").resourceFromAttributes;
  PeriodicExportingMetricReader: typeof import("@opentelemetry/sdk-metrics").PeriodicExportingMetricReader;
  NodeSDK: typeof import("@opentelemetry/sdk-node").NodeSDK;
  ParentBasedSampler: typeof import("@opentelemetry/sdk-trace-base").ParentBasedSampler;
  TraceIdRatioBasedSampler: typeof import("@opentelemetry/sdk-trace-base").TraceIdRatioBasedSampler;
  ATTR_SERVICE_NAME: string;
}> {
  const [
    metricsExporter,
    traceExporter,
    resources,
    sdkMetrics,
    sdkNode,
    sdkTraceBase,
    semconv,
  ] = await Promise.all([
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/semantic-conventions"),
  ]);
  return {
    OTLPMetricExporter: metricsExporter.OTLPMetricExporter,
    OTLPTraceExporter: traceExporter.OTLPTraceExporter,
    resourceFromAttributes: resources.resourceFromAttributes,
    PeriodicExportingMetricReader: sdkMetrics.PeriodicExportingMetricReader,
    NodeSDK: sdkNode.NodeSDK,
    ParentBasedSampler: sdkTraceBase.ParentBasedSampler,
    TraceIdRatioBasedSampler: sdkTraceBase.TraceIdRatioBasedSampler,
    ATTR_SERVICE_NAME: semconv.ATTR_SERVICE_NAME,
  };
}
