/**
 * Public surface of the diagnostics package.
 *
 * Emission sites import the singleton bus:
 *   import { diagnostics } from "../infra/diagnostics/index.js";
 *   diagnostics.emit("tool.execution.completed", { ... });
 *
 * The OTEL exporter (commit 2) and the optional pino bridge are
 * subscribers; they live in their own files.
 */

export { diagnostics, createDiagnosticBus, bridgeDiagnosticsToPino } from "./bus.js";
export type { DiagnosticBus, DiagnosticHandler } from "./bus.js";
export { createMemorySampler } from "./memory-sampler.js";
export type { MemorySampler, MemorySamplerOptions } from "./memory-sampler.js";
export { createOtelExporter, attributesFromEvent } from "./otel-exporter.js";
export type { OtelExporter, OtelExporterConfig } from "./otel-exporter.js";
export type {
  DiagnosticEventPayload,
  DiagnosticEventType,
  DiagnosticEventInput,
  DiagnosticTraceContext,
  DiagnosticToolExecutionStarted,
  DiagnosticToolExecutionCompleted,
  DiagnosticToolExecutionError,
  DiagnosticToolLoop,
  DiagnosticExecProcessCompleted,
  DiagnosticModelCallCompleted,
  DiagnosticModelCallError,
  DiagnosticContextAssembled,
  DiagnosticMessageDeliveryStarted,
  DiagnosticMessageDeliveryCompleted,
  DiagnosticMessageDeliveryError,
  DiagnosticMessageDeliveryKind,
  DiagnosticMemorySample,
  DiagnosticMemoryPressure,
  DiagnosticMemoryUsage,
  DiagnosticAuditRecorded,
  DiagnosticTelemetryExporter,
  DiagnosticToolParamsSummary,
} from "./events.js";
