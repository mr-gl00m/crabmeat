import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";
import { diagnostics } from "../infra/diagnostics/index.js";
import type { Provider, ProviderRequest, StreamEvent } from "./providers/types.js";

interface CooldownEntry {
  until: number;
}

export type PriorityMode = "config-order" | "api-first" | "local-first";

export interface ModelSelectorOptions {
  /** Reorder the cascade chain. Default "config-order" leaves the array as-written. */
  priorityMode?: PriorityMode;
  /** Optional sessionKey to thread through into fallback diagnostic events. */
  sessionKeyProvider?: () => string | undefined;
}

/**
 * Patterns in error messages that indicate a model-level configuration
 * problem (the *current* model can't satisfy the request) rather than a
 * provider outage. When an error matches one of these, we DO NOT mark
 * the provider down at all — a model swap will fix it, and bricking
 * the provider for the whole session is the wrong remedy.
 *
 * Bug history: a single 400 "does not support tools" from a swapped-in
 * cydonia-24b permanently disabled the entire ollama provider, which
 * meant every subsequent request — even after swapping back to a model
 * that *does* support tools — got "All providers are unavailable".
 */
const MODEL_LEVEL_ERROR_PATTERNS: RegExp[] = [
  /does not support tools/i,
  /tool[_ ]?use not supported/i,
  /model not found/i,
  /unknown model/i,
  /no such model/i,
  // Ollama returns 500 with "error parsing tool call" when the model
  // emits malformed JSON in its tool_call payload (e.g. an unescaped
  // `\$` in a price string). That's a model-output-quality issue, not
  // a provider outage — bricking the provider for 30s would just mean
  // every following email also fails until the user notices.
  /error parsing tool call/i,
];

function isModelLevelError(err: unknown): boolean {
  if (!err) return false;
  const msg = formatErrorMessage(err);
  return MODEL_LEVEL_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * Loopback-host check used by api-first / local-first priority sorts.
 * Mirrors the localhost detection in config/schema.ts isSafeBaseUrl.
 */
function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Reorder providers based on priorityMode. Stable within each bucket so
 * ties preserve the original config order — useful when the user
 * intentionally orders backups by preference.
 */
function sortProvidersByPriority(
  providers: Provider[],
  mode: PriorityMode,
): Provider[] {
  if (mode === "config-order") return providers.slice();
  const local: Provider[] = [];
  const api: Provider[] = [];
  for (const p of providers) {
    (isLoopbackBaseUrl(p.baseUrl) ? local : api).push(p);
  }
  return mode === "local-first" ? [...local, ...api] : [...api, ...local];
}

/**
 * Model selector with failover. Tries providers in order, skipping
 * those in cooldown. Marks providers as temporarily down on transient
 * errors. **Permanent marking is intentionally not done from a single
 * inference attempt** — it's too easy to brick a provider for the
 * whole session over a transient issue or a per-model quirk. After
 * COOLDOWN_MS, every provider becomes retryable again.
 *
 * Providers tagged role:"uncensored" are excluded from the cascade
 * chain — they're only reachable via tryStreamWithProvider (the
 * refusal-reroute path), since cascading transport errors into the
 * uncensored slot would defeat the point of having a dedicated slot
 * for content the primary refused.
 */
export function createModelSelector(
  providers: Provider[],
  opts: ModelSelectorOptions = {},
) {
  const cooldowns = new Map<string, CooldownEntry>();
  const COOLDOWN_MS = 30_000; // 30s cooldown on transient errors

  const allProviders = providers.slice();
  const chainProviders = sortProvidersByPriority(
    allProviders.filter((p) => p.role !== "uncensored"),
    opts.priorityMode ?? "config-order",
  );

  function isAvailable(provider: Provider): boolean {
    const entry = cooldowns.get(provider.id);
    if (!entry) return true;
    if (Date.now() >= entry.until) {
      cooldowns.delete(provider.id);
      return true;
    }
    return false;
  }

  function markDown(provider: Provider): void {
    logger.warn(
      { providerId: provider.id, cooldownMs: COOLDOWN_MS },
      "Provider in cooldown",
    );
    cooldowns.set(provider.id, {
      until: Date.now() + COOLDOWN_MS,
    });
  }

  function emitFallback(
    from: Provider,
    to: Provider,
    reason: "transient_error" | "cascadable_error" | "refusal" | "empty_stream",
    attempt: number,
    errorCategory?: string,
  ): void {
    diagnostics.emit("model.fallback.triggered", {
      sessionKey: opts.sessionKeyProvider?.(),
      fromProvider: from.id,
      toProvider: to.id,
      fromModel: from.model,
      toModel: to.model,
      reason,
      ...(errorCategory ? { errorCategory } : {}),
      attempt,
    });
  }

  return {
    /**
     * Try each provider in order. On retryable error, mark the provider
     * as temporarily down and try the next. On cascadable error, advance
     * without cooldown. Returns when one succeeds or all fail.
     */
    async tryStream(
      request: ProviderRequest,
      onEvent: (event: StreamEvent) => void,
    ): Promise<void> {
      const available = chainProviders.filter(isAvailable);

      if (available.length === 0) {
        onEvent({
          type: "error",
          error: new Error("All providers are unavailable"),
          retryable: false,
        });
        return;
      }

      for (let i = 0; i < available.length; i++) {
        const provider = available[i]!;
        let succeeded = false;
        let lastError: StreamEvent | undefined;

        await provider.stream(
          { ...request, model: getModelForProvider(provider, request.model) },
          (event) => {
            if (event.type === "error") {
              lastError = event;
            } else if (event.type === "done") {
              succeeded = true;
              onEvent(event);
            } else {
              // Token — means we're getting data, this provider works
              succeeded = true;
              onEvent(event);
            }
          },
        );

        if (succeeded) return;

        // Silent-stream failure: the provider returned without emitting a
        // token, a done, or an error. Treat as a retryable failure rather
        // than falling through silently — otherwise exhausting the chain
        // leaves the caller staring at an empty stream with no diagnostic.
        if (!lastError) {
          logger.warn(
            { providerId: provider.id },
            "Provider returned empty stream with no events — synthesizing retryable error",
          );
          lastError = {
            type: "error",
            error: new Error(
              `Provider ${provider.id} returned no events (empty stream). Likely a dropped connection or misconfigured provider.`,
            ),
            retryable: true,
          };
        }

        // Provider failed
        if (lastError.type === "error") {
          // Cascadable errors (404, 400-with-model-name-message, etc.)
          // are config issues, not provider outages — advance the chain
          // immediately without cooldown. Takes precedence over the
          // model-level message-pattern check below: a cascadable error
          // whose text happens to match (e.g. "model not found") is
          // still a config issue we want to route past, not a stop.
          const cascadable = lastError.cascadable === true;

          if (!cascadable) {
            // Model-level errors (e.g. "model does not support tools")
            // are NOT a provider problem — don't put the whole provider
            // in cooldown. Just propagate the error so the user sees it.
            if (isModelLevelError(lastError.error)) {
              logger.info(
                { providerId: provider.id, err: lastError.error instanceof Error ? lastError.error.message : String(lastError.error) },
                "Model-level error — provider stays available",
              );
              onEvent(lastError);
              return;
            }

            markDown(provider);
          }

          // If there are more providers to try, continue
          if (i < available.length - 1) {
            const nextProvider = available[i + 1]!;
            const reason: "transient_error" | "cascadable_error" | "empty_stream" =
              cascadable
                ? "cascadable_error"
                : lastError.error?.message?.includes("empty stream")
                  ? "empty_stream"
                  : "transient_error";
            const errorCategory =
              lastError.error?.constructor?.name ??
              (lastError.error instanceof Error ? lastError.error.name : undefined);
            // Status code is non-standard on Error subclasses, but the
            // OpenAI SDK's APIError carries it. Surface it on this log
            // so 400/404/429/5xx are all distinguishable in operator
            // logs without re-running with a debugger.
            const errStatus = (lastError.error as { status?: number } | undefined)?.status;
            logger.info(
              {
                failedProvider: provider.id,
                nextProvider: nextProvider.id,
                cascadable,
                errorCategory,
                errorStatus: errStatus,
                errorMessage:
                  lastError.error instanceof Error
                    ? lastError.error.message
                    : String(lastError.error),
              },
              "Failing over to next provider",
            );
            emitFallback(provider, nextProvider, reason, i + 1, errorCategory);
            continue;
          }

          // Last provider — propagate the error
          onEvent(lastError);
        }
      }
    },

    /**
     * Stream from a specific provider by id, bypassing the failover chain.
     * Used by the refusal-interception layer to deliberately route to a
     * fallback provider after the primary refused a request. Still
     * respects provider cooldowns — a down fallback returns an error
     * rather than silently doing nothing.
     *
     * Looks across ALL providers, including uncensored ones that are
     * excluded from the cascade chain.
     */
    async tryStreamWithProvider(
      providerId: string,
      request: ProviderRequest,
      onEvent: (event: StreamEvent) => void,
      ctx?: { fromProvider?: Provider; reason?: "refusal" },
    ): Promise<void> {
      const provider = allProviders.find((p) => p.id === providerId);
      if (!provider) {
        onEvent({
          type: "error",
          error: new Error(
            `Fallback provider "${providerId}" is not configured`,
          ),
          retryable: false,
        });
        return;
      }
      if (!isAvailable(provider)) {
        onEvent({
          type: "error",
          error: new Error(
            `Fallback provider "${providerId}" is in cooldown`,
          ),
          retryable: true,
        });
        return;
      }

      if (ctx?.fromProvider && ctx.reason) {
        emitFallback(ctx.fromProvider, provider, ctx.reason, 1);
      }

      await provider.stream(
        { ...request, model: getModelForProvider(provider, request.model) },
        (event) => {
          if (event.type === "error" && !isModelLevelError(event.error)) {
            markDown(provider);
          }
          onEvent(event);
        },
      );
    },

    /**
     * Look up a provider by its semantic role tag. Returns the FIRST
     * provider with the requested role, or undefined if none. Used by
     * the refusal-reroute path to find the dedicated uncensored slot.
     */
    findProviderByRole(role: "primary" | "backup" | "uncensored"): Provider | undefined {
      return allProviders.find((p) => p.role === role);
    },

    /** Reset all cooldowns (useful for config reload or /model swap). */
    resetCooldowns(): void {
      cooldowns.clear();
    },
  };
}

/**
 * Each provider config has its own model. The request carries a
 * "requested" model from the call site, but each provider in the
 * cascade chain has its own configured model name (e.g. gemini-pro
 * needs "gemini-2.5-pro", ollama-local needs "gpt-oss:latest"),
 * so handing the requested model through to every provider would
 * break failover the moment two providers diverge — the second
 * provider would 404 looking for the first provider's model name.
 *
 * The right value is the provider's own configured model. Falls back
 * to the requested model only when the provider has no configured
 * model — defensive for older Provider impls that pre-date the
 * `model` field, but in practice every provider built via the
 * registry sets it.
 */
function getModelForProvider(provider: Provider, requestedModel: string): string {
  return provider.model || requestedModel;
}
