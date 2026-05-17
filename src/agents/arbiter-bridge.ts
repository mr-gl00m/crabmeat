import { extractIntent, consult, execute } from "arbiter";
import type { Intent, ProviderFn, Result, ProviderMessage } from "arbiter";
import type { ConnectorSink } from "../connectors/types.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import { createTranscriptEntry } from "../sessions/transcript.js";
import type { Config, AgentConfig } from "../config/types.js";
import type { createModelSelector } from "./model-select.js";
import type { StreamEvent } from "./providers/types.js";
import { logger } from "../infra/logger.js";
import { humanizeInferenceError } from "../gateway/format-error.js";

type Selector = ReturnType<typeof createModelSelector>;

export function createArbiterProviderFn(
  selector: Selector,
  agent: AgentConfig,
  config: Config,
): ProviderFn {
  return async function* (
    messages: readonly ProviderMessage[],
  ): AsyncGenerator<{ delta: string }> {
    const queue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveNext: (() => void) | null = null;

    const wakeup = (): void => {
      const r = resolveNext;
      resolveNext = null;
      if (r) r();
    };

    const streamPromise = selector.tryStream(
      {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        model: config.providers[0]!.model,
        maxTokens: agent.maxTokens,
        temperature: agent.temperature,
      },
      (event: StreamEvent) => {
        if (event.type === "token") {
          queue.push(event.text);
          wakeup();
        } else if (event.type === "done") {
          done = true;
          wakeup();
        } else if (event.type === "error") {
          error = event.error;
          done = true;
          wakeup();
        }
      },
    );

    while (true) {
      if (queue.length > 0) {
        yield { delta: queue.shift()! };
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }

    await streamPromise;
    if (error) throw error;
  };
}

export interface ArbiterTurnContext {
  readonly content: string;
  readonly providerFn: ProviderFn;
  readonly sink: ConnectorSink;
  readonly session: Session;
  readonly store: SessionStore;
  readonly sessionKey: string;
  readonly workspace: string;
}

export interface ArbiterTurnOutcome {
  readonly handled: boolean;
  readonly reason: string;
}

function formatReceipt(intent: Intent, result: Result): string {
  if (!result.ok) {
    return `Arbiter declined the request: ${result.error ?? "unknown error"}`;
  }
  switch (intent.action) {
    case "file_write": {
      const out = result.output as { writtenTo?: string; bytes?: number };
      return `Wrote ${out.bytes ?? "?"} bytes to ${out.writtenTo ?? "(unknown path)"}`;
    }
    case "file_read": {
      const out = result.output as { content?: string };
      return out.content ?? "";
    }
    case "web_search": {
      const out = result.output as { query?: string; note?: string };
      return `Search "${out.query ?? ""}" — ${out.note ?? ""}`;
    }
  }
}

export async function runArbiterTurn(
  ctx: ArbiterTurnContext,
): Promise<ArbiterTurnOutcome> {
  const intent = extractIntent(ctx.content, { workspace: ctx.workspace });
  if (intent === null) {
    return { handled: false, reason: "no recognized intent" };
  }

  logger.info(
    {
      sessionKey: ctx.sessionKey,
      action: intent.action,
      effectClass: intent.effectClass,
      intentId: intent.id,
    },
    "Arbiter: intent extracted — running consult + execute",
  );

  let consultation;
  try {
    consultation = await consult(intent, ctx.providerFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Provider error messages can include deployment-shape data (provider
    // id, base URL, model name). Humanize before sending to the user-
    // visible sink; full detail stays in pino for debugging.
    // RT-2026-04-30-010.
    logger.warn(
      { sessionKey: ctx.sessionKey, intentId: intent.id, err: msg },
      "Arbiter consultation failed — surfacing humanized error to sink",
    );
    ctx.sink.sendToken(
      `Arbiter consultation failed: ${humanizeInferenceError(msg)}`,
      ctx.sessionKey,
    );
    ctx.sink.sendDone(ctx.sessionKey, intent.id);
    return { handled: true, reason: `consult error: ${msg}` };
  }

  const result = await execute(
    intent,
    { consultation },
    { workspace: ctx.workspace },
  );

  const receipt = formatReceipt(intent, result);
  ctx.sink.sendToken(receipt, ctx.sessionKey);
  ctx.sink.sendDone(ctx.sessionKey, intent.id);

  ctx.session.transcript.push(
    createTranscriptEntry("user", ctx.content, { source: "user_input" }),
    createTranscriptEntry("assistant", receipt, { source: "assistant" }),
  );
  await ctx.store.save(ctx.session);

  return {
    handled: true,
    reason: result.ok
      ? `executed ${intent.action} (intentId=${intent.id})`
      : `execute failed: ${result.error ?? "unknown"}`,
  };
}
