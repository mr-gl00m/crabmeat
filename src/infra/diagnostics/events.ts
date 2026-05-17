/**
 * Typed diagnostic event contract for CrabMeat's observability surface.
 *
 * Three-way split with the existing surfaces:
 *   - pino logger (infra/logger.ts) — developer-readable structured logs.
 *     Auto-redacts credentials and sessionKey via SHA-256 prefix.
 *   - audit log (security/audit.ts) — security/forensic hash chain.
 *     Records identity + effect with parameters redacted.
 *   - diagnostic events (this file) — ops/perf metrics and spans.
 *     Bounded cardinality; identifiers stripped at the OTEL export
 *     boundary in commit 2; no payloads at any layer.
 *
 * Redaction invariants (enforced by review + tests, since TypeScript
 * cannot statically forbid a field name):
 *   1. NO content. No prompt text, message body, command text, file
 *      contents, error messages with PII, or anything that could grow
 *      unboundedly. Char counts, byte counts, item counts only.
 *   2. Identifiers (sessionKey, sessionId, callId, runId) are present
 *      in the in-process event for correlation by subscribers, but the
 *      OTEL exporter strips them before export — they're high-cardinality
 *      and would explode metric labels.
 *   3. Errors carry `errorCategory: string` (low-cardinality class name
 *      like "TimeoutError"). The full error message goes through pino,
 *      not here.
 *   4. Provider/model names: low-cardinality strings, ≤64 chars.
 *
 * Event types are a discriminated union on `type`. Add new event kinds
 * by extending the union — every subscriber's exhaustive switch will
 * surface what's new at the type-checking layer.
 */

/**
 * W3C trace context fields, kept here so commit 2 (OTEL exporter) can
 * populate `trace` on emitted events without changing the contract.
 * Unused in commit 1 — single-process agent doesn't need distributed
 * tracing yet, but the field shape is reserved.
 */
export interface DiagnosticTraceContext {
  traceId: string;
  spanId: string;
  /** W3C trace flags byte; 0x01 = sampled. */
  traceFlags?: number;
  /** Parent span id when this event continues an existing span. */
  parentSpanId?: string;
}

/**
 * Common fields on every emitted event. The bus assigns `ts` and `seq`
 * at emit time so call sites don't have to thread a counter through.
 */
interface DiagnosticBaseEvent {
  /** Unix epoch ms, set by the bus on emit(). */
  ts: number;
  /** Per-bus monotonic sequence, set by the bus on emit(). */
  seq: number;
  /** Reserved for OTEL exporter; populated in commit 2. */
  trace?: DiagnosticTraceContext;
}

// ── Tool execution ─────────────────────────────────────────

/**
 * Low-cardinality summary of a tool's parameters. Captures shape and
 * size only — never values. Useful for "this tool is being called with
 * giant arrays" pattern detection without leaking content.
 */
export type DiagnosticToolParamsSummary =
  | { kind: "object" }
  | { kind: "array"; length: number }
  | { kind: "string"; length: number }
  | { kind: "number" | "boolean" | "null" | "undefined" | "other" };

interface DiagnosticToolExecutionBase extends DiagnosticBaseEvent {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  toolCallId?: string;
  paramsSummary?: DiagnosticToolParamsSummary;
}

export interface DiagnosticToolExecutionStarted extends DiagnosticToolExecutionBase {
  type: "tool.execution.started";
}

export interface DiagnosticToolExecutionCompleted extends DiagnosticToolExecutionBase {
  type: "tool.execution.completed";
  durationMs: number;
}

export interface DiagnosticToolExecutionError extends DiagnosticToolExecutionBase {
  type: "tool.execution.error";
  durationMs: number;
  errorCategory: string;
  errorCode?: string;
}

// ── Tool loop / circuit breaker ────────────────────────────

/**
 * Emitted when CrabMeat's circuit breaker records an anomaly or trips,
 * or when future loop-detectors (repeat call, ping-pong, no-progress)
 * fire. The detector enum leaves room for more granular detectors to
 * be added later.
 */
export interface DiagnosticToolLoop extends DiagnosticBaseEvent {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  /** Tool name when the detector is tool-scoped. Optional for global
   *  circuit-breaker trips that span auth/leak/non-tool anomalies. */
  toolName?: string;
  /** Low-cardinality category bucket — e.g. "auth", "tool", "leak", "inference". */
  category?: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector:
    | "generic_repeat"
    | "unknown_tool_repeat"
    | "known_poll_no_progress"
    | "global_circuit_breaker"
    | "ping_pong";
  count: number;
  /** Short low-cardinality reason string (e.g. "circuit_breaker_threshold"). */
  reason: string;
  pairedToolName?: string;
}

// ── Process exec (shell tool) ──────────────────────────────

export interface DiagnosticExecProcessCompleted extends DiagnosticBaseEvent {
  type: "exec.process.completed";
  sessionKey?: string;
  /** "host" = direct child_process; "sandbox" = future containerized exec. */
  target: "host" | "sandbox";
  outcome: "completed" | "failed";
  durationMs: number;
  /** Length of the command string in characters. NEVER the command itself. */
  commandLength: number;
  exitCode?: number;
  exitSignal?: string;
  timedOut?: boolean;
  failureKind?:
    | "shell-command-not-found"
    | "shell-not-executable"
    | "overall-timeout"
    | "no-output-timeout"
    | "signal"
    | "aborted"
    | "runtime-error";
}

// ── Model call lifecycle ───────────────────────────────────

interface DiagnosticModelCallBase extends DiagnosticBaseEvent {
  /** Run id from the inference turn loop, when threaded through. Optional in
   *  commit 1 — proper correlation arrives with OTEL trace context in commit 2. */
  runId?: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  /** API surface within a provider, e.g. "messages", "responses". */
  api?: string;
  /** Transport hint, e.g. "http", "stream". */
  transport?: string;
  /** Hashed upstream request id (provider's correlation token). Never raw. */
  upstreamRequestIdHash?: string;
}

export interface DiagnosticModelCallCompleted extends DiagnosticModelCallBase {
  type: "model.call.completed";
  durationMs: number;
  /** Token usage tally. Caller passes through provider's usage report. */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface DiagnosticModelCallError extends DiagnosticModelCallBase {
  type: "model.call.error";
  durationMs: number;
  errorCategory: string;
}

/**
 * Emitted when the failover cascade advances from one provider to the
 * next within a single turn — either because a transport error was
 * marked retryable/cascadable, or because the refusal-interception
 * layer rerouted to the uncensored fallback. Lets operators see
 * "request hit two layers before answering" without spelunking pino
 * logs. Bounded cardinality: provider/model strings are config-derived
 * and capped low, reason is a closed enum.
 */
export interface DiagnosticModelFallbackTriggered extends DiagnosticBaseEvent {
  type: "model.fallback.triggered";
  sessionKey?: string;
  fromProvider: string;
  toProvider: string;
  fromModel: string;
  toModel: string;
  reason: "transient_error" | "cascadable_error" | "refusal" | "empty_stream";
  errorCategory?: string;
  /** 1-indexed hop count within this turn (1 = first failover). */
  attempt: number;
}

// ── Context assembly ───────────────────────────────────────

/**
 * Emitted once per inference turn after buildContextWindow has shaped
 * the messages array. Gives operators visibility into "where did my
 * context go" — pinned region size, history size, prompt budget. Feeds
 * Phase 4.6 long-response work directly.
 */
export interface DiagnosticContextAssembled extends DiagnosticBaseEvent {
  type: "context.assembled";
  /** See DiagnosticModelCallBase.runId — optional in commit 1. */
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  channel?: string;
  trigger?: string;
  messageCount: number;
  historyTextChars: number;
  historyImageBlocks: number;
  maxMessageTextChars: number;
  systemPromptChars: number;
  promptChars: number;
  promptImages: number;
  contextTokenBudget?: number;
  reserveTokens?: number;
}

// ── Outbound message delivery ──────────────────────────────

/**
 * Outbound delivery lifecycle. Wired into the email connector's SMTP
 * send path first — every Phase 4 email-threading regression becomes
 * a span trace instead of log spelunking. Generic `channel` field lets
 * future webhook/voice/etc. connectors emit the same event shape.
 */
export type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";

interface DiagnosticMessageDeliveryBase extends DiagnosticBaseEvent {
  channel: string;
  sessionKey?: string;
  deliveryKind: DiagnosticMessageDeliveryKind;
}

export interface DiagnosticMessageDeliveryStarted extends DiagnosticMessageDeliveryBase {
  type: "message.delivery.started";
}

export interface DiagnosticMessageDeliveryCompleted extends DiagnosticMessageDeliveryBase {
  type: "message.delivery.completed";
  durationMs: number;
  /** Connector-specific delivery id (e.g. SMTP Message-Id). Hashed if it could
   *  be considered sensitive; raw is acceptable for SMTP since RFC 5322 makes
   *  Message-Id non-secret by design. */
  deliveryIdHash?: string;
}

export interface DiagnosticMessageDeliveryError extends DiagnosticMessageDeliveryBase {
  type: "message.delivery.error";
  durationMs: number;
  errorCategory: string;
}

// ── Memory ─────────────────────────────────────────────────

export interface DiagnosticMemoryUsage {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface DiagnosticMemorySample extends DiagnosticBaseEvent {
  type: "memory.sample";
  memory: DiagnosticMemoryUsage;
  uptimeMs?: number;
}

export interface DiagnosticMemoryPressure extends DiagnosticBaseEvent {
  type: "memory.pressure";
  level: "warning" | "critical";
  reason: "rss_threshold" | "heap_threshold" | "rss_growth";
  memory: DiagnosticMemoryUsage;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
}

// ── Audit cross-link (CrabMeat-specific) ───────────────────

/**
 * Emitted when audit.ts records a hash-chained entry. Lets operators
 * see audit-rate, effect-class breakdown, and denial rate without
 * reading the audit content itself. The audit log is still authoritative
 * for the security trail; this is just the metadata surface.
 */
export interface DiagnosticAuditRecorded extends DiagnosticBaseEvent {
  type: "audit.recorded";
  /** Audit entry seq — correlate with the audit log file. */
  auditSeq: number;
  sessionKey?: string;
  toolId: string;
  toolName: string;
  effectClass: string;
  resultStatus: "success" | "error" | "denied";
  durationMs: number;
}

// ── Compaction lifecycle ───────────────────────────────────

/**
 * Emitted when the inference loop or /compact command begins LLM-driven
 * history compaction. The compaction call has a 45-second timeout, so a
 * UI subscriber can use this as the "show spinner" signal.
 */
export interface DiagnosticCompactionStarted extends DiagnosticBaseEvent {
  type: "compaction.started";
  sessionKey?: string;
  transcriptEntries: number;
  totalTokens: number;
  tokenBudget: number;
  trigger: "auto" | "manual";
}

/**
 * Emitted when LLM-driven compaction fails and the hard-truncation
 * fallback runs. The user otherwise sees no signal that earlier turns
 * silently dropped from context — this event is the seam an operator
 * UI can surface as "context compacted (LLM summary unavailable)."
 */
export interface DiagnosticCompactionFallthrough extends DiagnosticBaseEvent {
  type: "compaction.fallthrough";
  sessionKey?: string;
  errorCategory: string;
  droppedEntries: number;
  keptEntries: number;
}

// ── Self-instrumentation ───────────────────────────────────

/**
 * Emitted by the OTEL exporter (commit 2) when an export attempt
 * succeeds, fails, or recovers. Lets operators verify that telemetry
 * is actually reaching its destination, without exporting the
 * raw error text from the OTLP client.
 */
export interface DiagnosticTelemetryExporter extends DiagnosticBaseEvent {
  type: "telemetry.exporter";
  exporter: string;
  signal: "traces" | "metrics" | "logs";
  state: "ready" | "failed" | "recovered";
  /** Low-cardinality failure class. Never the upstream error text. */
  errorCategory?: string;
}

// ── Union ──────────────────────────────────────────────────

export type DiagnosticEventPayload =
  | DiagnosticToolExecutionStarted
  | DiagnosticToolExecutionCompleted
  | DiagnosticToolExecutionError
  | DiagnosticToolLoop
  | DiagnosticExecProcessCompleted
  | DiagnosticModelCallCompleted
  | DiagnosticModelCallError
  | DiagnosticModelFallbackTriggered
  | DiagnosticContextAssembled
  | DiagnosticMessageDeliveryStarted
  | DiagnosticMessageDeliveryCompleted
  | DiagnosticMessageDeliveryError
  | DiagnosticMemorySample
  | DiagnosticMemoryPressure
  | DiagnosticAuditRecorded
  | DiagnosticCompactionStarted
  | DiagnosticCompactionFallthrough
  | DiagnosticTelemetryExporter;

export type DiagnosticEventType = DiagnosticEventPayload["type"];

/**
 * Helper type for the bus.emit() signature: caller supplies everything
 * except `ts` and `seq`, which the bus stamps on.
 */
export type DiagnosticEventInput<T extends DiagnosticEventType = DiagnosticEventType> =
  Omit<Extract<DiagnosticEventPayload, { type: T }>, "ts" | "seq">;
