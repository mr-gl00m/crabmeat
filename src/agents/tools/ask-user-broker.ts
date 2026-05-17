/**
 * ask_user broker — bridges tool handler to an external transport
 * (WebSocket) so the agent can request clarification from the user
 * mid-turn and wait for their reply.
 *
 * Design:
 *   1. Transport layer (ws handler) registers a send-fn per sessionKey.
 *   2. Tool handler calls askQuestion({sessionKey,...}) which:
 *        - emits a user.question event via the registered sender,
 *        - parks the call in a `pending` map keyed by questionId,
 *        - returns a Promise that resolves when receiveAnswer(id) lands.
 *   3. Transport layer calls receiveAnswer(id, answer, sessionKey)
 *      when the client replies with a `user.answer` frame.
 *   4. Questions time out after `timeoutMs` to prevent tool hangs.
 *   5. Disconnect / sender unregister cancels all pending for that session.
 *
 * No capabilities are leaked via this broker — the ws handler enforces
 * session ownership before calling receiveAnswer.
 */

import { formatErrorMessage } from "../../infra/errors.js";

export const DEFAULT_ASK_TIMEOUT_MS = 60_000;
export const MAX_ASK_TIMEOUT_MS = 5 * 60_000;
export const MIN_ASK_TIMEOUT_MS = 1_000;

/** Data sent to the client as a user.question event. */
export interface UserQuestionPayload {
  questionId: string;
  sessionId: string;
  question: string;
  options: string[];
  allowFreeform: boolean;
}

/** Answer from the client (via user.answer frame). */
export interface UserAnswer {
  /** The text the user replied with — freeform or the text of a chosen option. */
  answer: string;
  /** Optional index into the options array, if the client is picking one. */
  optionIndex?: number;
}

/** Send a single user.question event to a particular session's client. */
export type UserQuestionSender = (payload: UserQuestionPayload) => void;

interface Pending {
  questionId: string;
  sessionKey: string;
  resolve: (answer: UserAnswer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

const pending: Map<string, Pending> = new Map();
const senders: Map<string, UserQuestionSender> = new Map();

/**
 * Register a send-function for a session. Replaces any existing sender.
 * When replaced, pending questions for that session are cancelled
 * because a new client cannot observe events sent to the previous one.
 */
export function registerAskUserSender(
  sessionKey: string,
  sender: UserQuestionSender,
): void {
  if (senders.has(sessionKey)) {
    // A new transport is taking over this session — drop stale work.
    cancelAllForSession(sessionKey, "sender replaced");
  }
  senders.set(sessionKey, sender);
}

/** Unregister and reject any pending questions for the session. */
export function unregisterAskUserSender(sessionKey: string): void {
  senders.delete(sessionKey);
  cancelAllForSession(sessionKey, "client disconnected");
}

/** Cancel every pending question for a session with the given reason. */
export function cancelAllForSession(sessionKey: string, reason: string): void {
  for (const [id, p] of pending) {
    if (p.sessionKey === sessionKey) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error(`ask_user cancelled: ${reason}`));
    }
  }
}

/** For tests only — wipe all state. */
export function _resetAskUserBroker(): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("ask_user broker reset"));
  }
  pending.clear();
  senders.clear();
}

/** Count of pending questions (for tests and diagnostics). */
export function pendingCount(): number {
  return pending.size;
}

/**
 * Whether any pending ask_user question is waiting on a reply for the
 * given session. Used by the WS handler's session-eviction path to
 * refuse evicting a session whose user prompt would otherwise vanish
 * without notice. RT-2026-04-30-007.
 */
export function hasPendingForSession(sessionKey: string): boolean {
  for (const p of pending.values()) {
    if (p.sessionKey === sessionKey) return true;
  }
  return false;
}

export interface AskQuestionRequest {
  sessionKey: string;
  question: string;
  options?: string[];
  allowFreeform?: boolean;
  timeoutMs?: number;
}

/**
 * Send a question to the client and await their reply.
 * Rejects if no sender is registered for the session, if the timeout
 * fires, or if the client disconnects before answering.
 */
export function askQuestion(req: AskQuestionRequest): Promise<UserAnswer> {
  const sender = senders.get(req.sessionKey);
  if (!sender) {
    return Promise.reject(
      new Error(
        "ask_user: no active client for this session — cannot deliver question",
      ),
    );
  }

  const rawTimeout = req.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const timeoutMs = Math.max(
    MIN_ASK_TIMEOUT_MS,
    Math.min(MAX_ASK_TIMEOUT_MS, rawTimeout),
  );

  const questionId = crypto.randomUUID();
  const options = req.options ?? [];
  const allowFreeform = req.allowFreeform ?? true;

  return new Promise<UserAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(questionId)) {
        reject(new Error(`ask_user timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    pending.set(questionId, {
      questionId,
      sessionKey: req.sessionKey,
      resolve,
      reject,
      timer,
      createdAt: Date.now(),
    });

    try {
      sender({
        questionId,
        sessionId: req.sessionKey,
        question: req.question,
        options,
        allowFreeform,
      });
    } catch (err: unknown) {
      // Sender threw synchronously — clean up and reject.
      clearTimeout(timer);
      pending.delete(questionId);
      const msg = formatErrorMessage(err);
      reject(new Error(`ask_user send failed: ${msg}`));
    }
  });
}

/**
 * Called by the ws handler when a client sends a `user.answer` frame.
 * Returns true if a pending question was resolved, false otherwise.
 * The caller MUST verify sessionKey ownership before calling this.
 */
export function receiveAnswer(
  questionId: string,
  sessionKey: string,
  answer: UserAnswer,
): boolean {
  const p = pending.get(questionId);
  if (!p) return false;
  // Defence in depth: only the owning session may answer its own question.
  if (p.sessionKey !== sessionKey) return false;
  clearTimeout(p.timer);
  pending.delete(questionId);
  p.resolve(answer);
  return true;
}
