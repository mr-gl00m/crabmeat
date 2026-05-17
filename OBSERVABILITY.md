# Observability

CrabMeat exposes three independent observability surfaces. Each has a
distinct audience and a distinct invariant; none of them is a superset
of another.

| Surface | File | Audience | Invariant |
|---|---|---|---|
| Pino logs | `.crabmeat/logs/run-*.log` (and stdout) | developers reading a tail | structured JSONL, redacted credentials, sessionKey hashed to `sk:xxxxxxxxxxxx` |
| Audit log | `.crabmeat/audit/audit.jsonl` + `audit-snapshot.json` | security/forensic review | SHA-256 hash chain, parameters redacted, sessionKey unhashed for correlation |
| OTEL diagnostics | OTLP endpoint (or no-op) | ops in Grafana / equivalent | bounded cardinality, identifiers stripped at export, no payload content |

All three run side-by-side. Pino remains the place to read content;
the audit log remains authoritative for the security trail; OTEL is
strictly metrics + spans for ops/perf.

## What OTEL exports

Diagnostic events live in `src/infra/diagnostics/events.ts` as a typed
discriminated union. The OTEL exporter (`otel-exporter.ts`) subscribes
to the bus and translates each event:

- **Spans**: tool execution, model calls, message delivery, exec
  process, context assembly. Span name pattern `crabmeat.<area>`. Errors
  set `SpanStatusCode.ERROR` with a low-cardinality `errorCategory`.
- **Histograms**:
  - `gen_ai.client.token.usage` (input + output token buckets, GenAI
    semantic convention)
  - `gen_ai.client.operation.duration` (seconds, GenAI semantic convention)
  - `crabmeat.tool.execution.duration` (ms)
  - `crabmeat.message.delivery.duration` (ms)
  - `crabmeat.exec.process.duration` (ms)
  - `crabmeat.memory.rss` / `crabmeat.memory.heap_used` (bytes)
- **Counters**: `crabmeat.tool.loop.count`, `crabmeat.audit.recorded.count`,
  `crabmeat.memory.pressure.count`.

## What OTEL does NOT export

- **Identifier fields**: `sessionKey`, `sessionId`, `callId`, `runId`,
  `toolCallId`, `auditSeq`. They live in the in-process event for
  correlation by the pino bridge or test spies, but the exporter
  strips them. Putting these on metric labels would explode cardinality
  by orders of magnitude.
- **Payload content**: prompt text, message bodies, command text, file
  contents, stack traces. The event contract already excludes these;
  the exporter is a second line of defense (rejects strings outside
  `[A-Za-z0-9_.:\-/]{1,120}`).
- **Raw error messages**: only `errorCategory` (a low-cardinality class
  name like `"TimeoutError"`) reaches OTEL. Full stacks go to pino.
- **Audit content**: only `audit.recorded` counter increments reach
  OTEL. The hash chain stays in `audit.jsonl`.

## Configuration

The exporter is **silent no-op by default**. With no endpoint
configured anywhere, `createOtelExporter()` returns null and the bus
fans out only to whatever else has subscribed (e.g. the pino bridge).

Endpoint resolution order:

1. **`CRABMEAT_OTEL_PRELOADED=1`** — reuse an externally-registered
   OTEL SDK. Use this when your operator process already runs an OTEL
   collector or vendor agent and you just want CrabMeat to attach.
2. **Per-signal endpoint** — config field or env var, signal-specific
   beats base:
   - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
   - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
3. **Base endpoint** — `OTEL_EXPORTER_OTLP_ENDPOINT` covers all signals
   that don't have their own override.
4. **None of the above** — exporter returns null, no-op.

Other env knobs:

- `CRABMEAT_DIAGNOSTICS_LOG=1` — bridge every diagnostic event into
  pino at debug level (info for elevated events: pressure, errors,
  loops). Useful for dev runs without spinning up an OTLP collector.

Config-side fields (when constructing the exporter from code):

```ts
createOtelExporter(diagnostics, {
  serviceName: "crabmeat",          // resource attribute, defaults to "crabmeat"
  endpoint: "http://otel:4318",     // base, OTLP/HTTP+proto
  signalEndpoints: {
    traces: "http://otel-trace:4318",
    metrics: "http://otel-metric:4318",
  },
  sampleRate: 0.25,                 // 0..1, default 1
  metricExportIntervalMs: 60_000,
});
```

## Adding a new event type

1. Extend the union in `src/infra/diagnostics/events.ts`. Stick to the
   redaction invariants in the file's header comment (no payload
   fields, identifiers in the in-process event only, low-cardinality
   string fields only).
2. Add the new variant to `index.ts` re-exports if it's part of the
   public surface.
3. Wire emission at the natural seam (read the existing emission sites
   in `invoke.ts`, `inference.ts`, `email-imap.ts`, etc. for shape).
4. Extend `otel-exporter.ts` `handleEvent` switch with a new case.
5. Add a test case to `bus.test.ts`'s redaction check (it walks
   emitted payloads asserting no banned field names).

## Adding a new subscriber

The bus is plain pub/sub. Anything implementing
`(event: DiagnosticEventPayload) => void` can subscribe via
`diagnostics.subscribe(handler)` and receive the unsubscribe function.
Subscribers must be cheap and must not throw; the bus isolates
exceptions, but a slow subscriber will back up the emit path.
