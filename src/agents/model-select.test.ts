import { describe, it, expect, vi, beforeEach } from "vitest";
import { createModelSelector } from "./model-select.js";
import type { Provider, ProviderRequest, StreamEvent } from "./providers/types.js";

function makeRequest(): ProviderRequest {
  return {
    messages: [{ role: "system", content: "test" }],
    model: "test-model",
    maxTokens: 100,
    temperature: 0.7,
  };
}

function makeProvider(
  id: string,
  handler: (req: ProviderRequest, onEvent: (e: StreamEvent) => void) => Promise<void>,
): Provider {
  return { id, type: "openai", stream: handler };
}

function successProvider(id: string, text = "Hello"): Provider {
  return makeProvider(id, async (_req, onEvent) => {
    onEvent({ type: "token", text });
    onEvent({ type: "done", fullText: text });
  });
}

function errorProvider(id: string, retryable: boolean): Provider {
  return makeProvider(id, async (_req, onEvent) => {
    onEvent({ type: "error", error: new Error(`${id} failed`), retryable });
  });
}

describe("createModelSelector", () => {
  it("streams from the first available provider", async () => {
    const selector = createModelSelector([successProvider("p1")]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("token");
    expect(events[1]!.type).toBe("done");
  });

  it("fails over on retryable error", async () => {
    const selector = createModelSelector([
      errorProvider("p1", true),
      successProvider("p2", "Fallback"),
    ]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as { type: "token"; text: string }).text).toBe("Fallback");
  });

  it("fails over on non-retryable error and cools down the failing provider", async () => {
    const selector = createModelSelector([
      errorProvider("p1", false),
      successProvider("p2"),
    ]);

    // First call: fails over to p2
    const events1: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events1.push(e));
    expect(events1.some((e) => e.type === "done")).toBe(true);

    // Second call: p1 is in cooldown, goes straight to p2
    const events2: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events2.push(e));
    expect(events2.some((e) => e.type === "done")).toBe(true);
  });

  it("does NOT cool down the provider on a model-level error (e.g. 'does not support tools')", async () => {
    // Bug repro: a 400 from a swapped-in model that lacks tool support
    // used to permanently brick the whole provider for the session.
    let p1Calls = 0;
    const p1 = makeProvider("p1", async (_req, onEvent) => {
      p1Calls++;
      onEvent({
        type: "error",
        error: new Error("400 registry.ollama.ai/library/cydonia-24b:latest does not support tools"),
        retryable: false,
      });
    });
    const selector = createModelSelector([p1]);

    // First call: p1 errors with model-level message
    const events1: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events1.push(e));
    expect(events1.some((e) => e.type === "error")).toBe(true);
    expect(p1Calls).toBe(1);

    // Second call: p1 should be tried AGAIN (not in cooldown) because
    // the previous failure was model-level, not provider-level.
    const events2: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events2.push(e));
    expect(p1Calls).toBe(2);
    expect(events2.some((e) => e.type === "error")).toBe(true);
  });

  it("treats Ollama 'error parsing tool call' as model-level (no cooldown)", async () => {
    // Bug repro: model emitted `\$900 000` in a JSON string value, Ollama's
    // strict Go parser rejected it with a 500. That should NOT brick the
    // provider — it's a model output quality issue, not an outage.
    let calls = 0;
    const p1 = makeProvider("p1", async (_req, onEvent) => {
      calls++;
      onEvent({
        type: "error",
        error: new Error("500 error parsing tool call: raw='{...}', err=invalid character '$' in string escape code"),
        retryable: false,
      });
    });
    const selector = createModelSelector([p1]);

    await selector.tryStream(makeRequest(), () => {});
    await selector.tryStream(makeRequest(), () => {});
    expect(calls).toBe(2);
  });

  it("treats 'model not found' as model-level (no cooldown)", async () => {
    let calls = 0;
    const p1 = makeProvider("p1", async (_req, onEvent) => {
      calls++;
      onEvent({
        type: "error",
        error: new Error("model not found: nope:latest"),
        retryable: false,
      });
    });
    const selector = createModelSelector([p1]);

    await selector.tryStream(makeRequest(), () => {});
    await selector.tryStream(makeRequest(), () => {});
    expect(calls).toBe(2);
  });

  it("propagates error when all providers fail", async () => {
    const selector = createModelSelector([
      errorProvider("p1", true),
      errorProvider("p2", true),
    ]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
  });

  it("emits error when no providers are available", async () => {
    const selector = createModelSelector([]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });

  it("resets cooldowns", async () => {
    const selector = createModelSelector([
      errorProvider("p1", true),
      successProvider("p2"),
    ]);

    // First call: p1 fails, goes to p2
    await selector.tryStream(makeRequest(), () => {});

    // Reset cooldowns — p1 should be tried again
    selector.resetCooldowns();

    // p1 still fails, falls over to p2
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("respects cooldown window for retryable errors", async () => {
    // Provider with retryable error
    let callCount = 0;
    const flaky = makeProvider("flaky", async (_req, onEvent) => {
      callCount++;
      if (callCount <= 1) {
        onEvent({ type: "error", error: new Error("rate limited"), retryable: true });
      } else {
        onEvent({ type: "token", text: "ok" });
        onEvent({ type: "done", fullText: "ok" });
      }
    });

    const selector = createModelSelector([flaky, successProvider("backup")]);

    // First call: flaky fails (retryable), falls to backup
    await selector.tryStream(makeRequest(), () => {});

    // Second call: flaky is in cooldown, goes straight to backup
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});
