/**
 * Humanize raw inference / provider errors for end-user delivery channels
 * (email, chat). Raw provider errors leak implementation details — Go
 * stack snippets, the entire offending JSON blob, etc. — that are useless
 * to the user and arrive verbatim in their inbox. This helper rewrites
 * the most common ones into something a human can act on.
 *
 * Used by the inbound handler when constructing the reply body. The CLI /
 * WebSocket path is intentionally left raw so developers still see the
 * full diagnostic.
 */

interface ErrorRewrite {
  pattern: RegExp;
  rewrite: (raw: string) => string;
}

const REWRITES: ErrorRewrite[] = [
  {
    // Ollama 500: model emitted bad JSON in its tool call payload.
    // Often an unescaped `\$` in a string value.
    pattern: /error parsing tool call/i,
    rewrite: () =>
      "The active model emitted malformed JSON in a tool call (a common cause is an unescaped `$` in a string). " +
      "Try resending the request — this is often transient — or use `/model swap` to switch to a model that handles tool calls more reliably.",
  },
  {
    // Ollama 400 from a model that doesn't support function/tool calling.
    pattern: /does not support tools/i,
    rewrite: () =>
      "The active model doesn't support tool calls. Use `/model list` to see options and `/model swap <name|number>` to switch to one that does.",
  },
  {
    pattern: /(model not found|no such model|unknown model)/i,
    rewrite: () =>
      "The active model isn't available on the provider. Pull it with `ollama pull <name>` or use `/model swap` to pick a different one.",
  },
  {
    // Inference dead-ended with two consecutive empty turns. The user
    // sees this when the model refuses or stop_reasons out without
    // producing tokens; the raw form is "produced no output (zero tokens...)".
    pattern: /produced no output|EMPTY_RESPONSE/i,
    rewrite: () =>
      "The active model went silent — it ended its turn without producing any text or tool calls, even after a retry nudge. " +
      "Try `/model swap` to a different model, or rephrase the request — some models choke on long tool-result chains.",
  },
];

/**
 * Map a raw error message to a user-friendly explanation. Falls back to
 * a lightly-truncated version of the original when no pattern matches.
 *
 * The maxRawLen cap exists because some Ollama errors include the full
 * offending JSON blob inline — without truncation, the user gets several
 * KB of escaped JSON pasted into their email reply.
 */
export function humanizeInferenceError(raw: string, maxRawLen = 400): string {
  for (const r of REWRITES) {
    if (r.pattern.test(raw)) return r.rewrite(raw);
  }
  if (raw.length <= maxRawLen) return raw;
  return `${raw.slice(0, maxRawLen)}… (truncated)`;
}
