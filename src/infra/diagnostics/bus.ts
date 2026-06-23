/**
 * In-process event bus for diagnostic events.
 *
 * Architecture:
 *   - Emission sites depend ONLY on this file + ./events.ts.
 *   - Subscribers (OTEL exporter in commit 2, pino bridge for dev,
 *     test spies) live elsewhere and register via subscribe().
 *   - With zero subscribers attached, emit() is a no-op aside from
 *     stamping ts/seq — meaning the contract works pre-OTEL.
 *
 * This is deliberately simple: synchronous fan-out, no async queue,
 * no backpressure handling. Subscribers must be cheap. The OTEL
 * exporter does its own batching downstream of this bus.
 */

import type {
  DiagnosticEventPayload,
  DiagnosticEventType,
  DiagnosticEventInput,
} from "./events.js";

export type DiagnosticHandler = (event: DiagnosticEventPayload) => void;

export interface DiagnosticBus {
  /**
   * Emit an event. The bus stamps `ts` (Date.now) and `seq` (monotonic
   * per-bus counter) before fan-out. Type narrowing on `type` keeps
   * call-site mistakes at the type-checking layer.
   */
  emit<T extends DiagnosticEventType>(
    type: T,
    input: Omit<DiagnosticEventInput<T>, "type">,
  ): void;

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(handler: DiagnosticHandler): () => void;

  /**
   * Subscribe only to events of a given type. Caller's handler is
   * narrowed to that variant of the union.
   */
  subscribeOf<T extends DiagnosticEventType>(
    type: T,
    handler: (event: Extract<DiagnosticEventPayload, { type: T }>) => void,
  ): () => void;

  /** Number of currently registered handlers (across all types). */
  readonly subscriberCount: number;

  /** Drop all subscribers. For tests. */
  reset(): void;
}

export function createDiagnosticBus(): DiagnosticBus {
  const handlers = new Set<DiagnosticHandler>();
  let seq = 0;

  function fanOut(event: DiagnosticEventPayload): void {
    if (handlers.size === 0) return;
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        // A misbehaving subscriber must not break the emit path or
        // poison sibling subscribers. Swallow — pino bridge / OTEL
        // exporter each have their own internal error handling for
        // cases where they care.
      }
    }
  }

  return {
    emit(type, input) {
      // TS can't track that `input` carries the per-variant fields after
      // the spread + type-stamp; the emit() signature enforces shape at
      // every call site, so the runtime contract holds. Bridge via unknown.
      const event = {
        ...input,
        type,
        ts: Date.now(),
        seq: seq++,
      } as unknown as DiagnosticEventPayload;
      fanOut(event);
    },

    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    subscribeOf(type, handler) {
      const wrapped: DiagnosticHandler = (event) => {
        if (event.type === type) {
          handler(event as Extract<DiagnosticEventPayload, { type: typeof type }>);
        }
      };
      handlers.add(wrapped);
      return () => {
        handlers.delete(wrapped);
      };
    },

    get subscriberCount() {
      return handlers.size;
    },

    reset() {
      handlers.clear();
      seq = 0;
    },
  };
}

/**
 * Module-level singleton. All emission sites import this, the same
 * way they import the pino logger. Tests that need a fresh bus call
 * `diagnostics.reset()` in setup or build a local one with createDiagnosticBus().
 */
export const diagnostics: DiagnosticBus = createDiagnosticBus();

// ── Optional pino bridge ─────────────────────────────────────
//
// Lets dev runs see diagnostic events flow through the existing pino
// stream without spinning up the OTEL stack. Opt-in: nothing calls
// this by default. Wire it from entry.ts behind a flag if useful.

import type pino from "pino";

/**
 * Subscribe a pino logger to the bus. Each diagnostic event becomes a
 * structured log line at debug level (or info for pressure/error events).
 * Returns the unsubscribe function.
 *
 * The logger's existing redaction layer still applies to the structured
 * fields, so a sessionKey that lands in an event will be hashed to
 * `sk:xxxxxxxxxxxx` exactly the same as anywhere else.
 */
export function bridgeDiagnosticsToPino(
  bus: DiagnosticBus,
  logger: pino.Logger,
): () => void {
  return bus.subscribe((event) => {
    const isElevated =
      event.type === "memory.pressure" ||
      event.type === "tool.execution.error" ||
      event.type === "model.call.error" ||
      event.type === "message.delivery.error" ||
      event.type === "tool.loop";
    const level = isElevated ? "info" : "debug";
    logger[level]({ diagnostic: event }, `diagnostic:${event.type}`);
  });
}
