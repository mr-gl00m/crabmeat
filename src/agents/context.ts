import type { AgentConfig } from "../config/types.js";
import type { TranscriptEntry } from "../sessions/types.js";
import type { ChatMessage, ToolCallRequest, ToolDeclaration, SystemPromptBlock } from "./providers/types.js";
import { buildSystemPrompt, buildStructuredSystemPrompt } from "./system-prompt.js";
import { composeFragments, type FragmentContext } from "./prompt-fragments.js";
import { logger } from "../infra/logger.js";

/**
 * Rough token estimate using a configurable chars-per-token ratio.
 * Default is 3.5, which is closer to observed tokenizer behavior
 * than a flat 4. Code and structured data (JSON) tend toward ~3 chars/token;
 * English prose tends toward ~4. 3.5 is a conservative middle ground
 * that slightly overestimates (safer — leaves room vs. overflow).
 *
 * Callers can override via the module-level `setCharsPerToken()`.
 */
let charsPerToken = 3.5;

export function setCharsPerToken(ratio: number): void {
  if (ratio > 0) charsPerToken = ratio;
}

export function getCharsPerToken(): number {
  return charsPerToken;
}

/**
 * Set of agent IDs we've already warned about pinned-content size.
 * The pinned region is determined at startup (system prompt + tool catalog
 * + agent identity) and doesn't change inside a process, so re-warning on
 * every inference iteration just floods the log — one log report had this
 * line 23 times for a single email. Reset by tests via `_resetPinnedWarnings`.
 */
const warnedPinnedAgents = new Set<string>();

export function _resetPinnedWarnings(): void {
  warnedPinnedAgents.clear();
}

export function estimateTokens(text: string): number {
  // Use UTF-8 byte length, not JS string length. String length counts
  // UTF-16 code units — a CJK character or emoji is 1 unit but typically
  // 3-4 bytes, and tokenizers see roughly one token per 2-3 bytes for
  // those scripts. Dividing JS length by 3.5 dramatically underestimates
  // non-ASCII payloads and can overflow the provider's context window.
  // Byte length is a better proxy across scripts: ASCII unchanged,
  // multibyte scripts scale up naturally.
  return Math.ceil(Buffer.byteLength(text, "utf8") / charsPerToken);
}

export interface ContextWindow {
  messages: ChatMessage[];
  totalTokens: number;
  truncated: boolean;
  /** Tokens consumed by pinned system content (system prompt + tool catalog
   *  + identity + dynamic notices). Used downstream to detect provider-side
   *  truncation: if reported promptTokens < systemTokens, the wire was
   *  silently truncated (typically Ollama's num_ctx default kicking in). */
  systemTokens: number;
  /** Structured system prompt blocks for cache-aware providers. */
  systemBlocks?: SystemPromptBlock[];
}

/**
 * Build the context window with two regions:
 *
 * PINNED (never truncated):
 *   - System prompt with IRONCLAD_CONTEXT + tool schemas + trust notice
 *
 * COMPACTABLE (fills remaining budget):
 *   - Session history (oldest dropped first)
 *   - Tool call/result pairs
 *   - Current user message (always included)
 *
 * If pinned content exceeds 25% of budget, logs a warning.
 * If compactable budget is exhausted, truncates history (never pinned).
 */
export function buildContextWindow(
  agent: AgentConfig,
  transcript: TranscriptEntry[],
  maxTokenBudget: number,
  toolDeclarations?: ToolDeclaration[],
  canaryToken?: string,
  instructionContent?: string,
  identityContent?: string,
  dynamicNotices?: string,
  fragmentContext?: FragmentContext,
): ContextWindow {
  // --- Pinned region ---
  // Compose prompt fragments up front — each tool/connector registers its
  // own rules, the builder picks the ones relevant to this turn based on
  // the agent's toolset + inbound channel. Empty string when no context
  // is provided (older tests don't supply one).
  const composedFragments = fragmentContext
    ? composeFragments(fragmentContext)
    : "";

  const systemPrompt = buildSystemPrompt(agent, toolDeclarations, canaryToken, instructionContent, identityContent, dynamicNotices, composedFragments);
  const systemTokens = estimateTokens(systemPrompt);

  // Build structured prompt for cache-aware providers
  const structured = buildStructuredSystemPrompt(agent, toolDeclarations, canaryToken, instructionContent, identityContent, dynamicNotices, composedFragments);
  const systemBlocks: SystemPromptBlock[] = [
    { text: structured.cached, cacheControl: "ephemeral" },
    { text: structured.dynamic },
  ];

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  let totalTokens = systemTokens;
  let truncated = false;

  if (systemTokens > maxTokenBudget * 0.25 && !warnedPinnedAgents.has(agent.id)) {
    warnedPinnedAgents.add(agent.id);
    logger.warn(
      {
        agentId: agent.id,
        systemTokens,
        maxTokenBudget,
        ratio: (systemTokens / maxTokenBudget).toFixed(2),
      },
      "Pinned content exceeds 25% of token budget — system prompt or tool catalog may be too large",
    );
  }

  // --- Compactable region ---
  const compactableBudget = maxTokenBudget - systemTokens;
  if (compactableBudget <= 0) {
    return { messages, totalTokens, truncated: transcript.length > 0, systemTokens, systemBlocks };
  }

  // Group transcript into atomic units so tool call + result pairs
  // are never split (provider APIs break if they see one without the other).
  const units = groupTranscriptUnits(transcript);

  // Build history from newest to oldest, then reverse.
  const historyMessages: ChatMessage[] = [];
  let historyTokens = 0;

  for (let u = units.length - 1; u >= 0; u--) {
    const unit = units[u]!;
    if (historyTokens + unit.totalTokens > compactableBudget) {
      truncated = true;
      break;
    }
    for (let e = unit.entries.length - 1; e >= 0; e--) {
      historyMessages.unshift(transcriptToMessage(unit.entries[e]!));
    }
    historyTokens += unit.totalTokens;
  }

  totalTokens += historyTokens;
  messages.push(...historyMessages);

  return { messages, totalTokens, truncated, systemTokens, systemBlocks };
}

// --- Atomic grouping ---

export interface ContextUnit {
  entries: TranscriptEntry[];
  totalTokens: number;
}

/**
 * Group transcript entries into atomic units.
 * An assistant entry with toolCalls is grouped with all immediately
 * following tool result entries so they are included/excluded together.
 */
export function groupTranscriptUnits(transcript: TranscriptEntry[]): ContextUnit[] {
  const units: ContextUnit[] = [];
  let i = 0;
  while (i < transcript.length) {
    const entry = transcript[i]!;
    const record = entry as unknown as Record<string, unknown>;

    if (entry.role === "assistant" && record.toolCalls) {
      // Collect assistant + all following tool results as one unit
      const group: TranscriptEntry[] = [entry];
      let tokens = estimateTokens(entry.content);
      let j = i + 1;
      while (j < transcript.length && transcript[j]!.role === "tool") {
        group.push(transcript[j]!);
        tokens += estimateTokens(transcript[j]!.content);
        j++;
      }
      units.push({ entries: group, totalTokens: tokens });
      i = j;
    } else {
      units.push({
        entries: [entry],
        totalTokens: estimateTokens(entry.content),
      });
      i++;
    }
  }
  return units;
}

/**
 * Convert a transcript entry to a ChatMessage.
 * Handles tool results and assistant tool calls.
 */
function transcriptToMessage(entry: TranscriptEntry): ChatMessage {
  const record = entry as unknown as Record<string, unknown>;

  // Tool result → role "tool" with toolCallId
  if (entry.role === "tool") {
    return {
      role: "tool",
      content: entry.content,
      toolCallId: (record.toolCallId as string) ?? undefined,
    };
  }

  // Assistant with tool calls
  if (entry.role === "assistant" && record.toolCalls) {
    return {
      role: "assistant",
      content: entry.content,
      toolCalls: record.toolCalls as ToolCallRequest[],
    };
  }

  // System, user, or plain assistant
  return {
    role: entry.role as "system" | "user" | "assistant",
    content: entry.content,
  };
}
