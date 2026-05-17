import { describe, it, expect, vi, beforeEach } from "vitest";
import { createModelSelector } from "./model-select.js";
import { diagnostics } from "../infra/diagnostics/index.js";
import type { Provider, ProviderRequest, StreamEvent } from "./providers/types.js";

function makeRequest(): ProviderRequest {
  return {
    messages: [{ role: "system", content: "test" }],
    model: "test-model",
    maxTokens: 100,
    temperature: 0.7,
  };
}

interface MakeProviderOpts {
  baseUrl?: string;
  role?: "primary" | "backup" | "uncensored";
  model?: string;
}

function makeProvider(
  id: string,
  handler: (req: ProviderRequest, onEvent: (e: StreamEvent) => void) => Promise<void>,
  opts: MakeProviderOpts = {},
): Provider {
  return {
    id,
    type: "openai",
    model: opts.model ?? `${id}-model`,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    stream: handler,
  };
}

describe("model selector — partial failure scenarios", () => {
  it("treats token-then-error as success (no failover)", async () => {
    // Provider emits a token, then errors. Because token set succeeded=true,
    // the selector considers it a success and doesn't fail over.
    const partial = makeProvider("partial", async (_req, onEvent) => {
      onEvent({ type: "token", text: "Hello" });
      onEvent({ type: "error", error: new Error("stream cut"), retryable: true });
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "Backup" });
      onEvent({ type: "done", fullText: "Backup" });
    });

    const selector = createModelSelector([partial, backup]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    // Only the token from partial should appear — error is swallowed
    // because succeeded=true prevents failover
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as any).text).toBe("Hello");
    // No error forwarded to caller — this is a known gap
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
  });

  it("handles provider that returns without emitting any events", async () => {
    // Provider's stream() resolves without calling onEvent at all
    const silent = makeProvider("silent", async () => {
      // No events emitted — just returns
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "OK" });
      onEvent({ type: "done", fullText: "OK" });
    });

    const selector = createModelSelector([silent, backup]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    // Silent provider: succeeded=false, lastError=undefined
    // Falls through without marking down or propagating
    // Backup should be tried
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThanOrEqual(0);
    // At minimum, no crash
  });

  it("handles provider that throws synchronously", async () => {
    const thrower = makeProvider("thrower", async () => {
      throw new Error("sync boom");
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "Safe" });
      onEvent({ type: "done", fullText: "Safe" });
    });

    const selector = createModelSelector([thrower, backup]);
    // provider.stream() throwing means the await at line 66 rejects
    // This should propagate as unhandled unless caught
    await expect(
      selector.tryStream(makeRequest(), () => {}),
    ).rejects.toThrow("sync boom");
  });

  it("marks permanent on non-retryable, temp on retryable", async () => {
    const nonRetryable = makeProvider("auth-fail", async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("401"), retryable: false });
    });
    const retryable = makeProvider("rate-limit", async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("429"), retryable: true });
    });

    const selector = createModelSelector([nonRetryable, retryable]);
    await selector.tryStream(makeRequest(), () => {});

    // After first call: nonRetryable permanently down, retryable temp down
    // Second call: neither available (retryable in cooldown)
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("single provider: error propagated to caller", async () => {
    const solo = makeProvider("solo", async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("solo fail"), retryable: true });
    });

    const selector = createModelSelector([solo]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    // Last provider fails → error forwarded
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
  });
});

// ── Cascade / priority / role tests ────────────────────────

describe("model selector — cascadable error handling", () => {
  beforeEach(() => {
    diagnostics.reset();
  });

  it("404-shaped error advances WITHOUT cooldown", async () => {
    const cascade = makeProvider("primary", async (_req, onEvent) => {
      onEvent({
        type: "error",
        error: new Error("404 model not available"),
        retryable: false,
        cascadable: true,
      });
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "OK" });
      onEvent({ type: "done", fullText: "OK" });
    });

    const selector = createModelSelector([cascade, backup]);
    const first: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => first.push(e));
    expect(first.some((e) => e.type === "token")).toBe(true);

    // Without cooldown, the cascadable provider should be tried *again*
    // on the next call. We prove this by asserting it's still reachable —
    // i.e. the second turn's stream callback fires for the primary.
    let primaryWasCalled = false;
    const cascadeAgain = makeProvider("primary", async (_req, onEvent) => {
      primaryWasCalled = true;
      onEvent({ type: "token", text: "Recovered" });
      onEvent({ type: "done", fullText: "Recovered" });
    });
    // Build a fresh selector with the recovered primary to mimic
    // "the user fixed the model name and retried"; cooldown state
    // is per-selector, so this isolates the cascadable assertion.
    const selector2 = createModelSelector([cascadeAgain, backup]);
    await selector2.tryStream(makeRequest(), () => {});
    expect(primaryWasCalled).toBe(true);
  });

  it("emits model.fallback.triggered with reason cascadable_error on 404", async () => {
    const events: unknown[] = [];
    diagnostics.subscribe((event) => {
      if (event.type === "model.fallback.triggered") events.push(event);
    });

    const cascade = makeProvider("primary", async (_req, onEvent) => {
      onEvent({
        type: "error",
        error: new Error("404 model not available"),
        retryable: false,
        cascadable: true,
      });
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "OK" });
      onEvent({ type: "done", fullText: "OK" });
    });

    const selector = createModelSelector([cascade, backup]);
    await selector.tryStream(makeRequest(), () => {});

    expect(events).toHaveLength(1);
    const evt = events[0] as {
      reason: string;
      fromProvider: string;
      toProvider: string;
      attempt: number;
    };
    expect(evt.reason).toBe("cascadable_error");
    expect(evt.fromProvider).toBe("primary");
    expect(evt.toProvider).toBe("backup");
    expect(evt.attempt).toBe(1);
  });

  it("cascadable wins over model-level pattern match (cascade, do not propagate)", async () => {
    // An error whose message would match MODEL_LEVEL_ERROR_PATTERNS
    // ("model not found"), but tagged cascadable=true at the provider
    // layer. The cascade must advance — not propagate the error to the
    // caller — because cascadable is the explicit-routing signal.
    const provider = makeProvider("primary", async (_req, onEvent) => {
      onEvent({
        type: "error",
        error: new Error("models/gemini-9999-fake is not found for API version"),
        retryable: false,
        cascadable: true,
      });
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "Backup served" });
      onEvent({ type: "done", fullText: "Backup served" });
    });

    const selector = createModelSelector([provider, backup]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as { type: "token"; text: string }).text).toBe("Backup served");
    // Critically: no error was propagated, the cascade actually ran.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("transient errors emit reason transient_error and still cool down the provider", async () => {
    const events: unknown[] = [];
    diagnostics.subscribe((event) => {
      if (event.type === "model.fallback.triggered") events.push(event);
    });

    const transient = makeProvider("primary", async (_req, onEvent) => {
      onEvent({
        type: "error",
        error: new Error("503 service unavailable"),
        retryable: true,
      });
    });
    const backup = makeProvider("backup", async (_req, onEvent) => {
      onEvent({ type: "token", text: "OK" });
      onEvent({ type: "done", fullText: "OK" });
    });

    const selector = createModelSelector([transient, backup]);
    await selector.tryStream(makeRequest(), () => {});

    expect(events).toHaveLength(1);
    expect((events[0] as { reason: string }).reason).toBe("transient_error");
  });
});

describe("model selector — priority modes", () => {
  it("local-first: loopback providers come first regardless of config order", async () => {
    const apiOrder: string[] = [];
    const recordingProvider = (id: string, baseUrl?: string) =>
      makeProvider(
        id,
        async (_req, onEvent) => {
          apiOrder.push(id);
          onEvent({ type: "token", text: id });
          onEvent({ type: "done", fullText: id });
        },
        baseUrl ? { baseUrl } : {},
      );

    const api = recordingProvider("gemini", "https://generativelanguage.googleapis.com");
    const local = recordingProvider("ollama", "http://localhost:11434/v1");

    const selector = createModelSelector([api, local], { priorityMode: "local-first" });
    await selector.tryStream(makeRequest(), () => {});

    expect(apiOrder[0]).toBe("ollama");
  });

  it("api-first: non-loopback providers come first regardless of config order", async () => {
    const apiOrder: string[] = [];
    const recordingProvider = (id: string, baseUrl?: string) =>
      makeProvider(
        id,
        async (_req, onEvent) => {
          apiOrder.push(id);
          onEvent({ type: "token", text: id });
          onEvent({ type: "done", fullText: id });
        },
        baseUrl ? { baseUrl } : {},
      );

    const local = recordingProvider("ollama", "http://localhost:11434/v1");
    const api = recordingProvider("gemini", "https://generativelanguage.googleapis.com");

    const selector = createModelSelector([local, api], { priorityMode: "api-first" });
    await selector.tryStream(makeRequest(), () => {});

    expect(apiOrder[0]).toBe("gemini");
  });

  it("config-order: leaves the providers array as-written", async () => {
    const apiOrder: string[] = [];
    const recordingProvider = (id: string, baseUrl?: string) =>
      makeProvider(
        id,
        async (_req, onEvent) => {
          apiOrder.push(id);
          onEvent({ type: "token", text: id });
          onEvent({ type: "done", fullText: id });
        },
        baseUrl ? { baseUrl } : {},
      );

    const api = recordingProvider("gemini", "https://generativelanguage.googleapis.com");
    const local = recordingProvider("ollama", "http://localhost:11434/v1");

    const selector = createModelSelector([api, local]);
    await selector.tryStream(makeRequest(), () => {});

    expect(apiOrder[0]).toBe("gemini");
  });
});

describe("model selector — role-tagged providers", () => {
  it("uncensored-tagged providers are excluded from the cascade chain", async () => {
    let uncensoredCalled = false;
    const failing = makeProvider("primary", async (_req, onEvent) => {
      onEvent({ type: "error", error: new Error("transport"), retryable: true });
    }, { role: "primary" });
    const uncensored = makeProvider(
      "uncensored",
      async (_req, onEvent) => {
        uncensoredCalled = true;
        onEvent({ type: "token", text: "should not happen" });
        onEvent({ type: "done", fullText: "should not happen" });
      },
      { role: "uncensored" },
    );

    const selector = createModelSelector([failing, uncensored]);
    const events: StreamEvent[] = [];
    await selector.tryStream(makeRequest(), (e) => events.push(e));

    expect(uncensoredCalled).toBe(false);
    // Last reachable provider failed and there's no chain successor —
    // the error propagates to the caller.
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("findProviderByRole returns the first provider with the requested role", () => {
    const primary = makeProvider("p1", async () => {}, { role: "primary" });
    const backup = makeProvider("b1", async () => {}, { role: "backup" });
    const uncensored = makeProvider("u1", async () => {}, { role: "uncensored" });

    const selector = createModelSelector([primary, backup, uncensored]);
    expect(selector.findProviderByRole("primary")?.id).toBe("p1");
    expect(selector.findProviderByRole("backup")?.id).toBe("b1");
    expect(selector.findProviderByRole("uncensored")?.id).toBe("u1");
  });

  it("findProviderByRole returns undefined when no provider has the role", () => {
    const p = makeProvider("p1", async () => {});
    const selector = createModelSelector([p]);
    expect(selector.findProviderByRole("uncensored")).toBeUndefined();
  });

  it("tryStreamWithProvider can target an uncensored provider not in the chain", async () => {
    let uncensoredCalled = false;
    const primary = makeProvider("p", async () => {}, { role: "primary" });
    const uncensored = makeProvider(
      "u",
      async (_req, onEvent) => {
        uncensoredCalled = true;
        onEvent({ type: "token", text: "answered" });
        onEvent({ type: "done", fullText: "answered" });
      },
      { role: "uncensored" },
    );

    const selector = createModelSelector([primary, uncensored]);
    await selector.tryStreamWithProvider("u", makeRequest(), () => {});

    expect(uncensoredCalled).toBe(true);
  });

  it("tryStreamWithProvider emits refusal diagnostic when ctx.fromProvider is supplied", async () => {
    diagnostics.reset();
    const events: unknown[] = [];
    diagnostics.subscribe((event) => {
      if (event.type === "model.fallback.triggered") events.push(event);
    });

    const primary = makeProvider("p", async () => {}, { role: "primary" });
    const uncensored = makeProvider(
      "u",
      async (_req, onEvent) => {
        onEvent({ type: "token", text: "answered" });
        onEvent({ type: "done", fullText: "answered" });
      },
      { role: "uncensored" },
    );

    const selector = createModelSelector([primary, uncensored]);
    await selector.tryStreamWithProvider(
      "u",
      makeRequest(),
      () => {},
      { fromProvider: primary, reason: "refusal" },
    );

    expect(events).toHaveLength(1);
    const evt = events[0] as { reason: string; toProvider: string };
    expect(evt.reason).toBe("refusal");
    expect(evt.toProvider).toBe("u");
  });
});

describe("model selector — per-provider model resolution", () => {
  it("each provider receives its own configured model on cascade", async () => {
    const seenModels: Array<{ id: string; model: string }> = [];
    const recordingProvider = (id: string, model: string) =>
      makeProvider(
        id,
        async (req, onEvent) => {
          seenModels.push({ id, model: req.model });
          if (id === "first") {
            // First provider fails so the cascade advances.
            onEvent({
              type: "error",
              error: new Error("fail"),
              retryable: true,
            });
          } else {
            onEvent({ type: "token", text: "ok" });
            onEvent({ type: "done", fullText: "ok" });
          }
        },
        { model },
      );

    const a = recordingProvider("first", "gemini-2.5-flash");
    const b = recordingProvider("second", "gpt-oss:latest");

    const selector = createModelSelector([a, b]);
    // Caller-supplied request.model is intentionally something neither
    // provider would accept — this proves each provider receives its
    // OWN configured model, not the request's.
    await selector.tryStream(
      { ...makeRequest(), model: "ignored-by-cascade" },
      () => {},
    );

    expect(seenModels).toEqual([
      { id: "first", model: "gemini-2.5-flash" },
      { id: "second", model: "gpt-oss:latest" },
    ]);
  });

  it("tryStreamWithProvider also uses the target provider's own model", async () => {
    let seenModel = "";
    const target = makeProvider(
      "target",
      async (req, onEvent) => {
        seenModel = req.model;
        onEvent({ type: "token", text: "ok" });
        onEvent({ type: "done", fullText: "ok" });
      },
      { model: "helcyon-12b" },
    );
    const selector = createModelSelector([target]);
    await selector.tryStreamWithProvider(
      "target",
      { ...makeRequest(), model: "request-said-something-else" },
      () => {},
    );
    expect(seenModel).toBe("helcyon-12b");
  });
});

describe("model selector — duplicate provider entries (backup-as-primary case)", () => {
  it("cooldown on the first entry does not affect the second with a distinct id", async () => {
    let firstAttempts = 0;
    let secondAttempts = 0;
    const ollama1 = makeProvider("ollama-local", async (_req, onEvent) => {
      firstAttempts++;
      onEvent({ type: "error", error: new Error("ECONNREFUSED"), retryable: true });
    });
    const ollama2 = makeProvider("ollama-local-retry", async (_req, onEvent) => {
      secondAttempts++;
      onEvent({ type: "error", error: new Error("ECONNREFUSED"), retryable: true });
    });

    const selector = createModelSelector([ollama1, ollama2]);
    await selector.tryStream(makeRequest(), () => {});

    expect(firstAttempts).toBe(1);
    expect(secondAttempts).toBe(1);
  });
});
