/**
 * Root chat component. Composes:
 *   - useReducer over chat state (messages, agentBusy, currentTool, ...)
 *   - useWebSocket hook for gateway connection + event dispatch
 *   - ChatHistory (Static-rendered scrollback)
 *   - Live AssistantMessage (the currently-streaming response)
 *   - StatusLine (shimmer + elapsed when busy and not streaming)
 *   - PromptInput (the framed input box)
 *
 * Slash commands handled here: /help, /quit, /clear, /history.
 * Other agent commands (/compact, /model, /identity, …) pass through
 * to the gateway as normal chat.send messages — the gateway's command
 * router takes them.
 */

import { Box, Static, Text, useApp, useInput } from "ink";
import { useReducer, useState, useCallback, useEffect, useMemo } from "react";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type ChatMessage,
  type PendingQuestion,
} from "./reducer.js";
import { useWebSocket, type ServerInfo } from "./ws.js";
import { MessageRow } from "./ChatHistory.js";
import { AssistantMessage } from "./ChatHistory.js";
import { StatusLine } from "./StatusLine.js";
import { PromptInput } from "./PromptInput.js";
import { BANNER_RAW_LINES, BANNER_TAGLINE } from "../ui.js";

export interface AppProps {
  url: string;
  token: string;
  channel?: string;
}

export function App({ url, token, channel }: AppProps) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [input, setInput] = useState("");
  const [welcome, setWelcome] = useState<ServerInfo | undefined>(undefined);
  const [welcomeShown, setWelcomeShown] = useState(false);
  const ink = useApp();

  const ws = useWebSocket({
    url,
    token,
    ...(channel ? { channel } : {}),
    dispatch,
    onWelcome: (info) => {
      setWelcome(info);
      setWelcomeShown(true);
    },
  });

  // Ctrl+C: graceful shutdown. Ink installs its own SIGINT handler;
  // useInput with key.ctrl+c is the recommended path inside an Ink app.
  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      ws.close();
      ink.exit();
    }
  });

  // Exit on auth failure once the user has seen the error message.
  useEffect(() => {
    if (ws.connection === "auth_failed") {
      const t = setTimeout(() => ink.exit(), 500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ws.connection, ink]);

  const handleSubmit = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      setInput("");

      // Pending ask_user question always wins. The reducer holds the
      // outstanding question; this input is the answer.
      if (state.pendingQuestion) {
        await sendAskUserAnswer(state.pendingQuestion, trimmed, ws.send, dispatch);
        return;
      }

      // ── Client-side commands ────────────────────────────
      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        ws.close();
        ink.exit();
        return;
      }
      if (trimmed === "/help" || trimmed === "/?") {
        dispatch({
          type: "SYSTEM",
          content: HELP_TEXT,
          level: "info",
        });
        return;
      }
      if (trimmed === "/clear" || trimmed === "/cls") {
        dispatch({ type: "RESET" });
        return;
      }
      if (trimmed === "/history") {
        const res = await ws.send("chat.history", { limit: 20 });
        if (res.status === "ok") {
          const data = res.data as { entries?: Array<{ role: string; content: string }> };
          const entries = data?.entries ?? [];
          if (entries.length === 0) {
            dispatch({ type: "SYSTEM", content: "No history available.", level: "info" });
          } else {
            const lines = entries
              .map((e) => `  ${e.role}: ${(e.content ?? "").slice(0, 120)}`)
              .join("\n");
            dispatch({
              type: "SYSTEM",
              content: `Session history (last ${entries.length}):\n${lines}`,
              level: "info",
            });
          }
        } else {
          dispatch({
            type: "SYSTEM",
            content: `History error: ${res.error?.message ?? "unknown"}`,
            level: "error",
          });
        }
        return;
      }

      // ── Send / queue to gateway ─────────────────────────
      if (ws.connection !== "connected") {
        dispatch({
          type: "SYSTEM",
          content: "Not connected — waiting for reconnection...",
          level: "warn",
        });
        return;
      }

      const queued = state.agentBusy;
      const params: Record<string, unknown> = { content: trimmed };
      if (channel) params.channelId = channel;

      // Echo the user's line into the history immediately. The reducer
      // marks agentBusy=true on a non-queued send so the StatusLine
      // mounts on the next render.
      dispatch({ type: "USER_SENT", content: trimmed, queued });

      const method = queued ? "chat.queue" : "chat.send";
      const res = await ws.send(method, params);
      if (res.status === "error") {
        dispatch({
          type: "ERROR",
          code: res.error?.code ?? "SEND_ERROR",
          message: res.error?.message ?? "Send failed",
        });
      }
    },
    [state.pendingQuestion, state.agentBusy, ws, ink, channel],
  );

  // Split messages into static (committed) vs the live streaming
  // assistant (re-rendered every tick as tokens land). Reducer
  // guarantees the live message — if any — is the last entry; tool
  // events freeze any prior streaming assistant before appending.
  const last = state.messages[state.messages.length - 1];
  const liveAssistant = last?.role === "assistant" && last.streaming ? last : null;
  const staticMessages = liveAssistant
    ? state.messages.slice(0, -1)
    : state.messages;

  const showStatus =
    state.agentBusy && state.turnStartMs !== null && !liveAssistant;
  const statusLabel = state.currentTool ?? "thinking";

  // Connection banner shown above everything when not connected — gives
  // the user feedback during reconnection without flooding history.
  const connectionBanner = renderConnectionBanner(ws.connection, ws.reconnectAttempts);

  // Combine welcome + message history into a single Static items list.
  // Ink commits Static items to scrollback above the dynamic region,
  // regardless of JSX position — so a separately-rendered banner ends
  // up *below* the chat history (under the dynamic region's bottom),
  // which is the opposite of where it should sit. Folding it into the
  // same Static keeps it pinned at the top of scrollback.
  const staticItems = useMemo<StaticItem[]>(() => {
    const items: StaticItem[] = [];
    if (welcomeShown) {
      items.push({ kind: "welcome", info: welcome, url });
    }
    for (const m of staticMessages) {
      items.push({ kind: "msg", message: m });
    }
    return items;
  }, [welcomeShown, welcome, url, staticMessages]);

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item, idx) =>
          item.kind === "welcome" ? (
            <WelcomeBanner key={`welcome-${idx}`} info={item.info} url={item.url} />
          ) : (
            <MessageRow key={item.message.id} message={item.message} />
          )
        }
      </Static>
      {liveAssistant ? (
        <AssistantMessage
          content={liveAssistant.content}
          tokens={liveAssistant.tokens}
          {...(liveAssistant.durationMs !== undefined
            ? { durationMs: liveAssistant.durationMs }
            : {})}
          streaming={liveAssistant.streaming}
        />
      ) : null}
      {showStatus ? (
        <StatusLine
          label={statusLabel}
          startMs={state.turnStartMs!}
          tokens={
            // Last assistant message's token count — surfaces during
            // multi-tool turns where some tokens streamed before a tool
            // fired and cleared the live assistant. Reads zero when no
            // assistant has spoken yet this turn.
            (last?.role === "assistant" ? last.tokens : 0) || 0
          }
        />
      ) : null}
      {connectionBanner}
      {state.pendingQuestion ? (
        <PendingQuestionPrompt question={state.pendingQuestion} />
      ) : null}
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        busy={state.agentBusy}
        disabled={ws.connection === "auth_failed"}
      />
    </Box>
  );
}

type StaticItem =
  | { kind: "welcome"; info: ServerInfo | undefined; url: string }
  | { kind: "msg"; message: ChatMessage };

function WelcomeBanner({
  info,
  url,
}: {
  info: ServerInfo | undefined;
  url: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Box flexDirection="column">
        {BANNER_RAW_LINES.map((line, i) => (
          <Box key={i}>
            <Text bold color="yellowBright">{line.left}</Text>
            <Text color="yellow">{line.right}</Text>
          </Box>
        ))}
        <Text dimColor>  {BANNER_TAGLINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>connected to {url}</Text>
      </Box>
      {info ? (
        <Box flexDirection="column">
          <Text dimColor>
            agent <Text color="yellow">{info.agent}</Text>
            {"  ·  "}
            model <Text color="yellow">{info.model}</Text>
            {"  ·  "}
            provider <Text color="yellow">{info.provider}</Text>
          </Text>
          <Text dimColor>
            tools <Text color="yellow">{info.tools}</Text>
            {"  ·  "}
            arbiter <Text color="yellow">{info.arbiter}</Text>
            {"  ·  "}
            sessions <Text color="yellow">{info.sessions}</Text>
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          Type <Text color="cyan">/help</Text> for commands, <Text color="cyan">/quit</Text> to disconnect.
        </Text>
      </Box>
    </Box>
  );
}

function PendingQuestionPrompt({ question }: { question: PendingQuestion }) {
  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text bold color="yellowBright">
        Agent is asking
      </Text>
      <Text bold>{question.question}</Text>
      {question.options.length > 0 ? (
        question.allowFreeform ? (
          <Text dimColor>{`suggestions: ${question.options.join(", ")}`}</Text>
        ) : (
          <Box flexDirection="column">
            {question.options.map((opt, i) => (
              <Box key={i}>
                <Text color="cyan">{`${i + 1}.`}</Text>
                <Text>{` ${opt}`}</Text>
              </Box>
            ))}
          </Box>
        )
      ) : null}
    </Box>
  );
}

function renderConnectionBanner(
  conn: import("./ws.js").ConnectionState,
  attempts: number,
) {
  if (conn === "connected") return null;
  if (conn === "connecting") {
    return (
      <Box paddingX={2}>
        <Text color="yellow">Connecting…</Text>
      </Box>
    );
  }
  if (conn === "authenticating") {
    return (
      <Box paddingX={2}>
        <Text color="yellow">Authenticating…</Text>
      </Box>
    );
  }
  if (conn === "reconnecting") {
    return (
      <Box paddingX={2}>
        <Text color="yellow">{`Reconnecting (attempt ${attempts})…`}</Text>
      </Box>
    );
  }
  if (conn === "disconnected") {
    return (
      <Box paddingX={2}>
        <Text color="red">Disconnected</Text>
      </Box>
    );
  }
  if (conn === "auth_failed") {
    return (
      <Box paddingX={2}>
        <Text color="red">Authentication failed</Text>
      </Box>
    );
  }
  return null;
}

async function sendAskUserAnswer(
  question: PendingQuestion,
  answer: string,
  send: (method: string, params: Record<string, unknown>) => Promise<{ status: string; error?: { code: string; message: string } }>,
  dispatch: (action: import("./reducer.js").ChatAction) => void,
): Promise<void> {
  // Numeric option index? Honor it. Otherwise treat as freeform — but
  // refuse if freeform isn't allowed. Mirrors the readline client's
  // handleAnswerLine logic.
  let optionIndex: number | undefined;
  const asNum = Number(answer);
  if (
    Number.isInteger(asNum) &&
    asNum >= 1 &&
    asNum <= question.options.length
  ) {
    optionIndex = asNum - 1;
  } else if (!question.allowFreeform && question.options.length > 0) {
    dispatch({
      type: "SYSTEM",
      content: `Please answer with 1–${question.options.length} (freeform not allowed).`,
      level: "warn",
    });
    return;
  }

  const params: Record<string, unknown> = {
    sessionId: question.sessionId,
    questionId: question.questionId,
    answer:
      optionIndex !== undefined ? question.options[optionIndex]! : answer,
  };
  if (optionIndex !== undefined) params.optionIndex = optionIndex;

  dispatch({ type: "ASK_USER_ANSWERED" });
  const res = await send("user.answer", params);
  if (res.status === "error") {
    dispatch({
      type: "ERROR",
      code: res.error?.code ?? "ANSWER_ERROR",
      message: res.error?.message ?? "Answer failed",
    });
  }
}

const HELP_TEXT = [
  "Commands:",
  "  /help, /?       — this list",
  "  /history        — show last 20 transcript entries",
  "  /clear          — wipe local history (gateway session keeps everything)",
  "  /quit, /exit    — disconnect",
  "",
  "Agent commands (sent to the gateway):",
  "  /compact        — force context compaction",
  "  /model          — show model | /model swap <name> | /model <#>",
  "  /identity       — show/edit agent identity",
  "  /status         — system health status",
  "  /kill           — trip circuit breaker",
  "  /reset          — re-enable after halt",
  "  /schedules      — list scheduled tasks",
  "",
  "Prefix with `ask:` to bypass Layer 0 and force LLM processing.",
].join("\n");

// State type re-export so callers (entry shim) can type the result of
// useReducer without importing reducer directly.
export type { ChatState };
