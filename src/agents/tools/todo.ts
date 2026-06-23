/**
 * todo_write — in-session planning scratchpad for the agent.
 *
 * The LLM uses this to commit to a multi-step plan, then checks items
 * off as it makes progress. It is deliberately dumb: pure in-memory
 * per-session state, no delegation, no child models, no filesystem.
 * For persistent user-facing task lists, use `tasks_manage` instead.
 *
 * Actions:
 *   - list   : return the current list
 *   - set    : replace the entire list (accepts strings or TodoItem objects)
 *   - update : update one item by id (status and/or text)
 *   - clear  : wipe the list
 *
 * Per-session list is capped at MAX_TODOS_PER_SESSION items. The total
 * number of tracked sessions is capped at MAX_SESSIONS with LRU eviction
 * so this cannot grow without bound.
 */

import { registerToolHandler } from "./handlers.js";
import type { ToolExecutionContext } from "./types.js";
import { logger } from "../../infra/logger.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export const MAX_TODOS_PER_SESSION = 50;
export const MAX_TODO_TEXT_LEN = 500;
export const MAX_TODO_SESSIONS = 256;
export const MAX_TODO_ID_LEN = 32;

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

// Map insertion order gives us LRU "for free": whenever we touch a
// session, we delete+re-insert so the oldest session is always the
// first key returned by `keys()`.
const todos: Map<string, TodoItem[]> = new Map();

function touchSession(key: string): void {
  const existing = todos.get(key);
  if (existing !== undefined) {
    todos.delete(key);
    todos.set(key, existing);
  }
}

function ensureCapacity(): void {
  while (todos.size >= MAX_TODO_SESSIONS) {
    const oldest = todos.keys().next().value;
    if (oldest === undefined) break;
    todos.delete(oldest);
  }
}

function getList(key: string): TodoItem[] {
  return todos.get(key) ?? [];
}

function setList(key: string, list: TodoItem[]): void {
  if (!todos.has(key)) ensureCapacity();
  todos.delete(key);
  todos.set(key, list);
}

/** For tests only — wipe all state. */
export function _resetTodoState(): void {
  todos.clear();
}

/** For tests only — read the raw list for a session. */
export function _peekTodos(sessionKey: string): TodoItem[] {
  return [...(todos.get(sessionKey) ?? [])];
}

/** For tests only — current number of tracked sessions. */
export function _todoSessionCount(): number {
  return todos.size;
}

function formatList(list: TodoItem[]): string {
  if (list.length === 0) return "No todos.";
  const lines = list.map((t) => {
    const marker =
      t.status === "completed"
        ? "[x]"
        : t.status === "in_progress"
          ? "[~]"
          : "[ ]";
    return `${marker} ${t.id}: ${t.text}`;
  });
  return `${list.length} todo(s):\n${lines.join("\n")}`;
}

function sanitizeId(raw: string, fallbackIndex: number): string {
  const trimmed = raw.trim().slice(0, MAX_TODO_ID_LEN);
  if (trimmed.length === 0) {
    return `td-${String(fallbackIndex + 1).padStart(2, "0")}`;
  }
  return trimmed;
}

async function handleTodoWrite(
  params: Record<string, unknown>,
  _signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<{ content: string; isError?: boolean; outputs?: Record<string, unknown> }> {
  const sessionKey = context?.sessionKey ?? "_global";
  const action = typeof params.action === "string" ? params.action : "";

  switch (action) {
    case "list": {
      touchSession(sessionKey);
      const list = getList(sessionKey);
      return {
        content: formatList(list),
        outputs: { action: "list", todos: list, count: list.length },
      };
    }

    case "set": {
      const raw = params.todos;
      if (!Array.isArray(raw)) {
        return { content: "todo_write: 'todos' must be an array.", isError: true };
      }
      if (raw.length > MAX_TODOS_PER_SESSION) {
        return {
          content: `todo_write: too many todos (${raw.length} > ${MAX_TODOS_PER_SESSION}).`,
          isError: true,
        };
      }
      const list: TodoItem[] = [];
      const seenIds = new Set<string>();
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        let text: string;
        let status: TodoStatus = "pending";
        let id: string;

        if (typeof item === "string") {
          text = item.trim();
          id = `td-${String(i + 1).padStart(2, "0")}`;
        } else if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          text = typeof obj.text === "string" ? obj.text.trim() : "";
          if (obj.status !== undefined) {
            const s = obj.status;
            if (typeof s !== "string" || !VALID_STATUSES.has(s as TodoStatus)) {
              return {
                content: `todo_write: item ${i} has invalid status '${String(s)}'.`,
                isError: true,
              };
            }
            status = s as TodoStatus;
          }
          const rawId = typeof obj.id === "string" ? obj.id : "";
          id = sanitizeId(rawId, i);
        } else {
          return {
            content: `todo_write: item ${i} must be a string or object.`,
            isError: true,
          };
        }

        if (text.length === 0) {
          return { content: `todo_write: item ${i} has empty text.`, isError: true };
        }
        if (text.length > MAX_TODO_TEXT_LEN) {
          return {
            content: `todo_write: item ${i} text too long (${text.length} > ${MAX_TODO_TEXT_LEN}).`,
            isError: true,
          };
        }
        if (seenIds.has(id)) {
          return { content: `todo_write: duplicate id '${id}'.`, isError: true };
        }
        seenIds.add(id);
        list.push({ id, text, status });
      }
      setList(sessionKey, list);
      return {
        content: `Set ${list.length} todo(s).\n${formatList(list)}`,
        outputs: { action: "set", todos: list, count: list.length },
      };
    }

    case "update": {
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) {
        return { content: "todo_write: 'id' is required for update.", isError: true };
      }
      const list = getList(sessionKey);
      const idx = list.findIndex((t) => t.id === id);
      if (idx === -1) {
        return { content: `todo_write: no todo with id '${id}'.`, isError: true };
      }
      const current = list[idx]!;
      let next: TodoItem = current;

      if (params.status !== undefined) {
        const s = params.status;
        if (typeof s !== "string" || !VALID_STATUSES.has(s as TodoStatus)) {
          return {
            content: `todo_write: invalid status '${String(s)}'. Use pending | in_progress | completed.`,
            isError: true,
          };
        }
        next = { ...next, status: s as TodoStatus };
      }

      if (params.text !== undefined) {
        const text = typeof params.text === "string" ? params.text.trim() : "";
        if (text.length === 0) {
          return { content: "todo_write: text must be non-empty.", isError: true };
        }
        if (text.length > MAX_TODO_TEXT_LEN) {
          return {
            content: `todo_write: text too long (max ${MAX_TODO_TEXT_LEN}).`,
            isError: true,
          };
        }
        next = { ...next, text };
      }

      if (next === current) {
        return {
          content: "todo_write: update had no effect — pass status and/or text.",
          isError: true,
        };
      }

      const newList = [...list];
      newList[idx] = next;
      setList(sessionKey, newList);
      return {
        content: `Updated '${id}'.\n${formatList(newList)}`,
        outputs: { action: "update", todos: newList, count: newList.length },
      };
    }

    case "clear": {
      todos.delete(sessionKey);
      return {
        content: "Cleared all todos.",
        outputs: { action: "clear", todos: [], count: 0 },
      };
    }

    case "":
      return {
        content: "todo_write: 'action' is required. Use: list, set, update, clear.",
        isError: true,
      };

    default:
      return {
        content: `todo_write: unknown action '${action}'. Use: list, set, update, clear.`,
        isError: true,
      };
  }
}

export function registerTodoTools(): void {
  registerToolHandler("todo_write", handleTodoWrite);
  logger.info({ tools: ["todo_write"] }, "Todo tool handler registered");
}
