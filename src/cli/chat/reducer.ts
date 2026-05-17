/**
 * Chat state reducer for the Ink-based chat client.
 *
 * Replaces the readline-era ChatState mutable bag with an immutable
 * state machine that React/Ink can re-render off of. The WebSocket
 * lifecycle hook (chat/ws.ts) and the App component dispatch actions
 * here; this file owns the canonical "what does the screen show" state.
 *
 * Connection state lives in a separate hook (useWebSocket) — keeping
 * it out of the reducer so reconnection churn doesn't trigger
 * full message-list re-renders.
 */

export interface PendingQuestion {
  sessionId: string;
  questionId: string;
  question: string;
  options: string[];
  allowFreeform: boolean;
}

export interface OutboundMirrorData {
  sessionId: string;
  messageId: string;
  channel: string;
  content: string;
  delivered: boolean;
  error?: string;
  killUrl?: string;
  timestamp: string;
}

export type ChatMessage =
  | {
      id: string;
      role: "user";
      content: string;
      timestamp: number;
      /** True when the line was sent via chat.queue rather than chat.send. */
      queued?: boolean;
    }
  | {
      id: string;
      role: "assistant";
      content: string;
      timestamp: number;
      streaming: boolean;
      tokens: number;
      /** Wall-clock ms from turn start to chat.done. Set when streaming flips false. */
      durationMs?: number;
    }
  | {
      id: string;
      role: "tool";
      toolName: string;
      status: "running" | "success" | "error" | string;
      timestamp: number;
    }
  | {
      id: string;
      role: "system";
      content: string;
      level: "info" | "warn" | "error" | "success";
      timestamp: number;
    }
  | {
      id: string;
      role: "outbound";
      data: OutboundMirrorData;
      timestamp: number;
    };

export interface ChatState {
  messages: ChatMessage[];
  /** A turn is in flight (chat.send sent, chat.done not yet received). */
  agentBusy: boolean;
  /** A chat.token has been received in the current turn. */
  streaming: boolean;
  /** Currently-running tool name, drives the StatusLine label. */
  currentTool: string | null;
  /** ms-since-epoch the current turn started. Drives elapsed clock. */
  turnStartMs: number | null;
  /** Outstanding ask_user question — input goes to the answer broker. */
  pendingQuestion: PendingQuestion | null;
}

export const initialChatState: ChatState = {
  messages: [],
  agentBusy: false,
  streaming: false,
  currentTool: null,
  turnStartMs: null,
  pendingQuestion: null,
};

export type ChatAction =
  | { type: "USER_SENT"; content: string; queued: boolean }
  | { type: "TOKEN"; text: string }
  | { type: "TURN_DONE" }
  | { type: "TOOL_EVENT"; toolName: string; status: "running" | "success" | string }
  | { type: "INPUT_QUEUED_ACK"; preview: string; position: number; kind: "control" | "queue" }
  | { type: "ASK_USER"; question: PendingQuestion }
  | { type: "ASK_USER_ANSWERED" }
  | { type: "OUTBOUND_MIRROR"; data: OutboundMirrorData }
  | { type: "SYSTEM"; content: string; level: "info" | "warn" | "error" | "success" }
  | { type: "ERROR"; code: string; message: string }
  | { type: "RESET" };

let messageIdCounter = 0;
function nextId(prefix: string): string {
  messageIdCounter += 1;
  return `${prefix}-${messageIdCounter}`;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "USER_SENT": {
      const msg: ChatMessage = {
        id: nextId("u"),
        role: "user",
        content: action.content,
        timestamp: Date.now(),
        ...(action.queued ? { queued: true } : {}),
      };
      // For non-queued sends we mark the agent busy and start the turn
      // clock. Queued sends ride along with whatever turn is already
      // in flight, so we don't reset turnStartMs.
      return {
        ...state,
        messages: [...state.messages, msg],
        ...(action.queued
          ? {}
          : {
              agentBusy: true,
              streaming: false,
              currentTool: null,
              turnStartMs: Date.now(),
            }),
      };
    }

    case "TOKEN": {
      // Per-chunk increment is +1 per ~4 chars of text, since the gateway
      // batches tokens through the leak buffer and a "chunk" is not the
      // same unit as a model token. Using event count alone made every
      // turn read "1 tok" once the leak buffer flushed the whole reply
      // in one go. The 4-char heuristic is the standard rough estimate;
      // we floor-min at 1 so even a single non-empty chunk registers.
      const chunkTokens = Math.max(
        1,
        Math.ceil(action.text.length / 4),
      );
      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        const updated: ChatMessage = {
          ...last,
          content: last.content + action.text,
          tokens: last.tokens + chunkTokens,
        };
        return {
          ...state,
          streaming: true,
          messages: [...state.messages.slice(0, -1), updated],
        };
      }
      const newMsg: ChatMessage = {
        id: nextId("a"),
        role: "assistant",
        content: action.text,
        timestamp: Date.now(),
        streaming: true,
        tokens: chunkTokens,
      };
      return {
        ...state,
        streaming: true,
        messages: [...state.messages, newMsg],
      };
    }

    case "TURN_DONE": {
      // Close out any open assistant message and surface a "silent
      // zero" system note when the agent produced neither tokens nor
      // tools — same affordance the readline client had. Counts are
      // recomputed from state.messages so the WS hook doesn't need
      // to track them in parallel.
      const last = state.messages[state.messages.length - 1];
      const lastTokens = last?.role === "assistant" ? last.tokens : 0;
      const durationMs = state.turnStartMs ? Date.now() - state.turnStartMs : 0;

      // Count tool events back to the most recent user message — that's
      // the boundary of "this turn." If we never hit a user message
      // (rare: very first turn was a system bootstrap), we just count
      // every tool we see, which is also right.
      let toolCount = 0;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]!;
        if (m.role === "user") break;
        if (m.role === "tool") toolCount += 1;
      }

      let messages = state.messages;
      if (last?.role === "assistant" && last.streaming) {
        const closed: ChatMessage = {
          ...last,
          streaming: false,
          durationMs,
        };
        messages = [...state.messages.slice(0, -1), closed];
      }
      if (lastTokens === 0 && toolCount === 0) {
        messages = [
          ...messages,
          {
            id: nextId("sys"),
            role: "system",
            content:
              "agent returned no output — nothing was said and no tools were called",
            level: "info",
            timestamp: Date.now(),
          },
        ];
      }
      return {
        ...state,
        messages,
        agentBusy: false,
        streaming: false,
        currentTool: null,
        turnStartMs: null,
      };
    }

    case "TOOL_EVENT": {
      // Tool events get appended as message rows AND update currentTool
      // for the StatusLine driver. "running" sets the live tool; any
      // terminal status clears it (the next tool will set its own).
      //
      // If a tool event fires while an assistant message is streaming,
      // freeze that assistant first — multi-step tool use means the
      // agent paused mid-response to call a tool, so whatever it had
      // said before the call is final. Subsequent tokens (after the
      // tool resolves) start a fresh assistant message at the bottom.
      // This keeps the static/live split simple: the live message is
      // always the most recent one.
      const last = state.messages[state.messages.length - 1];
      let messages = state.messages;
      if (last?.role === "assistant" && last.streaming) {
        const closed: ChatMessage = { ...last, streaming: false };
        messages = [...state.messages.slice(0, -1), closed];
      }
      const msg: ChatMessage = {
        id: nextId("t"),
        role: "tool",
        toolName: action.toolName,
        status: action.status,
        timestamp: Date.now(),
      };
      const isRunning = action.status === "running";
      return {
        ...state,
        messages: [...messages, msg],
        currentTool: isRunning ? action.toolName : null,
      };
    }

    case "INPUT_QUEUED_ACK": {
      // Server ack for a queued message. Render as a system note so
      // the user can see "queued [#2]: do this" the way the readline
      // client did, but without smashing the prompt.
      const content =
        action.kind === "control"
          ? "kill token sent — halting agent"
          : `queued [#${action.position}]: ${action.preview}`;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextId("sys"),
            role: "system",
            content,
            level: action.kind === "control" ? "warn" : "info",
            timestamp: Date.now(),
          },
        ],
      };
    }

    case "ASK_USER":
      return { ...state, pendingQuestion: action.question };

    case "ASK_USER_ANSWERED":
      return { ...state, pendingQuestion: null };

    case "OUTBOUND_MIRROR":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextId("out"),
            role: "outbound",
            data: action.data,
            timestamp: Date.now(),
          },
        ],
      };

    case "SYSTEM":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextId("sys"),
            role: "system",
            content: action.content,
            level: action.level,
            timestamp: Date.now(),
          },
        ],
      };

    case "ERROR": {
      // Errors close out any open turn and surface the failure as a
      // system row with error level. Matches the readline client's
      // sink.sendError visual.
      const last = state.messages[state.messages.length - 1];
      let messages = state.messages;
      if (last?.role === "assistant" && last.streaming) {
        const closed: ChatMessage = { ...last, streaming: false };
        messages = [...state.messages.slice(0, -1), closed];
      }
      return {
        ...state,
        messages: [
          ...messages,
          {
            id: nextId("sys"),
            role: "system",
            content: `Error: ${action.code} — ${action.message}`,
            level: "error",
            timestamp: Date.now(),
          },
        ],
        agentBusy: false,
        streaming: false,
        currentTool: null,
        turnStartMs: null,
      };
    }

    case "RESET":
      return initialChatState;

    default:
      return state;
  }
}
