import { z } from "zod";

// --- Base frame ---

const baseFrame = z.object({
  id: z.string(),
  type: z.enum(["req", "res", "event", "error"]),
});

// --- Request frames (client → server) ---

export const connectParamsSchema = z.object({
  protocolVersion: z.literal(1),
  token: z.string().optional(),
  password: z.string().optional(),
  deviceId: z.string().optional(),
});

export const connectFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("connect"),
  params: connectParamsSchema,
});

export const chatSendParamsSchema = z.object({
  channelId: z.string().optional(),
  peerId: z.string().optional(),
  content: z.string().min(1),
});

export const chatSendFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("chat.send"),
  params: chatSendParamsSchema,
});

export const chatHistoryParamsSchema = z.object({
  channelId: z.string().optional(),
  peerId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const chatHistoryFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("chat.history"),
  params: chatHistoryParamsSchema,
});

export const commandExecParamsSchema = z.object({
  name: z.string().min(1),
  args: z.string().default(""),
  channelId: z.string().optional(),
  peerId: z.string().optional(),
});

export const commandExecFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("command.exec"),
  params: commandExecParamsSchema,
});

export const userAnswerParamsSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().max(8192),
  optionIndex: z.number().int().min(0).max(64).optional(),
});

export const userAnswerFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("user.answer"),
  params: userAnswerParamsSchema,
});

/**
 * chat.queue — client-side interrupt lane.
 *
 * Lets the user type while the agent is mid-turn (streaming or running
 * tools). The content is buffered per-session and delivered at the next
 * safe boundary (before the next tool iteration). Control tokens like
 * `--killbot` are fast-pathed in the handler and trip the circuit
 * breaker immediately, without waiting for the loop to drain.
 *
 * channelId/peerId are echoed for routing parity with chat.send.
 */
export const chatQueueParamsSchema = z.object({
  channelId: z.string().optional(),
  peerId: z.string().optional(),
  // Empty content is validated in the handler so we can return a proper
  // error *response* (with replyTo) rather than a top-level error event.
  content: z.string().max(4000),
});

export const chatQueueFrameSchema = baseFrame.extend({
  type: z.literal("req"),
  method: z.literal("chat.queue"),
  params: chatQueueParamsSchema,
});

export const requestFrameSchema = z.discriminatedUnion("method", [
  connectFrameSchema,
  chatSendFrameSchema,
  chatHistoryFrameSchema,
  commandExecFrameSchema,
  userAnswerFrameSchema,
  chatQueueFrameSchema,
]);

// --- Response frames (server → client) ---

export const responseFrameSchema = baseFrame.extend({
  type: z.literal("res"),
  replyTo: z.string(),
  status: z.enum(["ok", "error"]),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

// --- Event frames (server → client, push) ---

export const chatTokenEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("chat.token"),
  data: z.object({
    token: z.string(),
    sessionId: z.string(),
  }),
});

export const chatDoneEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("chat.done"),
  data: z.object({
    sessionId: z.string(),
    messageId: z.string(),
  }),
});

export const toolExecuteEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("tool.execute"),
  data: z.object({
    sessionId: z.string(),
    toolName: z.string(),
    callId: z.string(),
    status: z.enum(["running", "success", "error"]),
    /** Optional metadata about the tool call — e.g. URL being fetched/browsed. */
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const auditEntryEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("audit.entry"),
  data: z.object({
    seq: z.number(),
    sessionId: z.string(),
    toolId: z.string(),
    effectClass: z.string(),
    resultStatus: z.enum(["success", "error", "denied"]),
    durationMs: z.number(),
    hash: z.string(),
  }),
});

export const commandRecognizedEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("command.recognized"),
  data: z.object({
    /** The matched command name (e.g. "help", "status"). */
    command: z.string(),
    /** The original frame ID this command is responding to. */
    replyTo: z.string(),
  }),
});

export const userQuestionEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("user.question"),
  data: z.object({
    sessionId: z.string(),
    questionId: z.string(),
    question: z.string(),
    options: z.array(z.string()),
    allowFreeform: z.boolean(),
  }),
});

export const messageOutboundMirrorEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("message.outbound"),
  data: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    channel: z.string(),
    content: z.string(),
    delivered: z.boolean(),
    error: z.string().optional(),
    killUrl: z.string().optional(),
    timestamp: z.string(),
  }),
});

/**
 * input.queued — server ack for chat.queue.
 *
 * Fires when a queued input is accepted (or a control token is
 * fast-pathed). `kind`:
 *   - "queued": buffered for next iteration boundary
 *   - "control": a control token was recognized and handled immediately
 *                (e.g. --killbot tripped the breaker)
 * `position` is the 1-based index in the pending buffer (control → 0).
 */
export const inputQueuedEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("input.queued"),
  data: z.object({
    sessionId: z.string(),
    kind: z.enum(["queued", "control"]),
    position: z.number().int().min(0),
    preview: z.string(),
  }),
});

export const permissionRequestEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("permission.request"),
  data: z.object({
    sessionId: z.string(),
    toolName: z.string(),
    effectNeeded: z.string(),
    reason: z.string(),
  }),
});

/**
 * chat.cost — per-turn running cost update. Emitted after a turn's
 * `done` event with the turn's USD delta and the running session
 * total. `priced: false` means the active model has no entry in the
 * pricing table; clients should render "cost unavailable" rather than
 * "$0.00" so an unpriced model is distinguishable from a free turn.
 */
export const chatCostEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("chat.cost"),
  data: z.object({
    sessionId: z.string(),
    turnUsd: z.number(),
    sessionUsd: z.number(),
    priced: z.boolean(),
  }),
});

/**
 * session.evicted — fired when a per-connection owned-session slot is
 * reclaimed because the connection hit MAX_OWNED_SESSIONS. Without this,
 * a queued ask_user on the evicted session dies silently. The handler
 * also refuses to evict sessions whose ask_user is still pending —
 * this event mainly fires for normal idle-eviction. RT-2026-04-30-007.
 */
export const sessionEvictedEventSchema = baseFrame.extend({
  type: z.literal("event"),
  event: z.literal("session.evicted"),
  data: z.object({
    sessionId: z.string(),
    reason: z.enum(["session_limit_reached"]),
  }),
});

export const errorEventSchema = baseFrame.extend({
  type: z.literal("error"),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// --- Exports ---

export type ConnectFrame = z.infer<typeof connectFrameSchema>;
export type ChatSendFrame = z.infer<typeof chatSendFrameSchema>;
export type ChatHistoryFrame = z.infer<typeof chatHistoryFrameSchema>;
export type CommandExecFrame = z.infer<typeof commandExecFrameSchema>;
export type UserAnswerFrame = z.infer<typeof userAnswerFrameSchema>;
export type ChatQueueFrame = z.infer<typeof chatQueueFrameSchema>;
export type InputQueuedEvent = z.infer<typeof inputQueuedEventSchema>;
export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type ChatTokenEvent = z.infer<typeof chatTokenEventSchema>;
export type ChatDoneEvent = z.infer<typeof chatDoneEventSchema>;
export type ToolExecuteEvent = z.infer<typeof toolExecuteEventSchema>;
export type AuditEntryEvent = z.infer<typeof auditEntryEventSchema>;
export type CommandRecognizedEvent = z.infer<typeof commandRecognizedEventSchema>;
export type PermissionRequestEvent = z.infer<typeof permissionRequestEventSchema>;
export type ChatCostEvent = z.infer<typeof chatCostEventSchema>;
export type UserQuestionEvent = z.infer<typeof userQuestionEventSchema>;
export type MessageOutboundMirrorEvent = z.infer<
  typeof messageOutboundMirrorEventSchema
>;
export type SessionEvictedEvent = z.infer<typeof sessionEvictedEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;

// --- Constants ---

export const PRE_AUTH_MAX_BYTES = 64 * 1024; // 64 KB
export const POST_AUTH_MAX_BYTES = 1024 * 1024; // 1 MB
export const PROTOCOL_VERSION = 1;

// --- Helpers ---

export function makeResponse(
  replyTo: string,
  data?: unknown,
): ResponseFrame {
  return {
    id: crypto.randomUUID(),
    type: "res",
    replyTo,
    status: "ok",
    data,
  };
}

export function makeErrorResponse(
  replyTo: string,
  code: string,
  message: string,
): ResponseFrame {
  return {
    id: crypto.randomUUID(),
    type: "res",
    replyTo,
    status: "error",
    error: { code, message },
  };
}

export function makeErrorEvent(code: string, message: string): ErrorEvent {
  return {
    id: crypto.randomUUID(),
    type: "error",
    error: { code, message },
  };
}

export function makeTokenEvent(
  token: string,
  sessionId: string,
): ChatTokenEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "chat.token",
    data: { token, sessionId },
  };
}

export function makeToolExecuteEvent(
  sessionId: string,
  toolName: string,
  callId: string,
  status: "running" | "success" | "error",
  meta?: Record<string, unknown>,
): ToolExecuteEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "tool.execute",
    data: { sessionId, toolName, callId, status, ...(meta && { meta }) },
  };
}

export function makeAuditEntryEvent(entry: {
  seq: number;
  sessionKey: string;
  toolId: string;
  effectClass: string;
  resultStatus: "success" | "error" | "denied";
  durationMs: number;
  hash: string;
}): AuditEntryEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "audit.entry",
    data: {
      seq: entry.seq,
      sessionId: entry.sessionKey,
      toolId: entry.toolId,
      effectClass: entry.effectClass,
      resultStatus: entry.resultStatus,
      durationMs: entry.durationMs,
      hash: entry.hash,
    },
  };
}

export function makePermissionRequestEvent(
  sessionId: string,
  toolName: string,
  effectNeeded: string,
  reason: string,
): PermissionRequestEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "permission.request",
    data: { sessionId, toolName, effectNeeded, reason },
  };
}

export function makeChatCostEvent(
  sessionId: string,
  turnUsd: number,
  sessionUsd: number,
  priced: boolean,
): ChatCostEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "chat.cost",
    data: { sessionId, turnUsd, sessionUsd, priced },
  };
}

export function makeCommandRecognizedEvent(
  command: string,
  replyTo: string,
): CommandRecognizedEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "command.recognized",
    data: { command, replyTo },
  };
}

export function makeDoneEvent(
  sessionId: string,
  messageId: string,
): ChatDoneEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "chat.done",
    data: { sessionId, messageId },
  };
}

export function makeUserQuestionEvent(payload: {
  sessionId: string;
  questionId: string;
  question: string;
  options: string[];
  allowFreeform: boolean;
}): UserQuestionEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "user.question",
    data: payload,
  };
}

export function makeInputQueuedEvent(payload: {
  sessionId: string;
  kind: "queued" | "control";
  position: number;
  preview: string;
}): InputQueuedEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "input.queued",
    data: payload,
  };
}

export function makeMessageOutboundMirrorEvent(payload: {
  sessionId: string;
  messageId: string;
  channel: string;
  content: string;
  delivered: boolean;
  error?: string;
  killUrl?: string;
  timestamp: string;
}): MessageOutboundMirrorEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "message.outbound",
    data: payload,
  };
}

export function makeSessionEvictedEvent(
  sessionId: string,
  reason: "session_limit_reached" = "session_limit_reached",
): SessionEvictedEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    event: "session.evicted",
    data: { sessionId, reason },
  };
}
