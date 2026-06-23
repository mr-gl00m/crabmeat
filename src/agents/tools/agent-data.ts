/**
 * Agent data system tools — AGENT.json, notes.json, user_profile.json.
 *
 * These tools let the agent read and update its own identity, scratch-pad
 * notes, and observations about the user. All three files live in .crabmeat/
 * and are user-editable.
 *
 * The agent is instructed (via system prompt) to proactively use these tools
 * to build up its personality and understanding of the user over time.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerToolHandler } from "./handlers.js";
import { registerPromptFragment } from "../prompt-fragments.js";
import { getWorkspaceRoot } from "./builtins.js";
import { writeJsonAtomic } from "../../infra/fs.js";
import { logger } from "../../infra/logger.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { agentIdentityPath } from "../identity-paths.js";

type HandlerResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

// ── Paths ───────────────────────────────────────────────

function dataDir(): string {
  return join(getWorkspaceRoot(), ".crabmeat");
}

function identityPath(): string {
  return agentIdentityPath(getWorkspaceRoot());
}

function notesPath(): string {
  return join(dataDir(), "notes.json");
}

function userProfilePath(): string {
  return join(dataDir(), "user_profile.json");
}

function tasksPath(): string {
  return join(dataDir(), "tasks.json");
}

// ── Helpers ─────────────────────────────────────────────

async function readJson(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeJsonAtomic(path, data);
}

// ── identity_read ───────────────────────────────────────

async function handleIdentityRead(
  _params: Record<string, unknown>,
): Promise<HandlerResult> {
  try {
    const data = await readJson(identityPath());
    if (!data) {
      return {
        content: "No AGENT.json found. Use identity_update to create one.",
        outputs: { identity: {} },
      };
    }
    return {
      content: JSON.stringify(data, null, 2),
      outputs: { identity: data as Record<string, unknown> },
    };
  } catch (err) {
    return { content: `Error reading AGENT.json: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── identity_update ─────────────────────────────────────

async function handleIdentityUpdate(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const updates = params.updates as Record<string, unknown> | undefined;
  if (!updates || typeof updates !== "object") {
    return { content: "The 'updates' parameter must be an object with fields to set/merge.", isError: true };
  }

  try {
    const path = identityPath();
    const existing = (await readJson(path) as Record<string, unknown>) ?? {};

    // Shallow merge — top-level keys are replaced, not deep-merged.
    // For nested objects like boundaries/preferences, the agent should
    // read first, modify, then write back the full sub-object.
    const merged = { ...existing, ...updates };

    await writeJson(path, merged);

    const changedKeys = Object.keys(updates);
    logger.info({ changedKeys }, "AGENT.json updated by agent");
    return {
      content: `Updated AGENT.json — changed: ${changedKeys.join(", ")}`,
      outputs: { identity: merged, updated_keys: changedKeys },
    };
  } catch (err) {
    return { content: `Error updating AGENT.json: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── Notes types ─────────────────────────────────────────

interface NoteEntry {
  id: string;
  content: string;
  created: string;
  expires?: string;
  tags?: string[];
}

interface NotesFile {
  entries: NoteEntry[];
}

// ── notes_read ──────────────────────────────────────────

async function handleNotesRead(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const tag = params.tag as string | undefined;

  try {
    const data = await readJson(notesPath()) as NotesFile | null;
    if (!data || !data.entries?.length) {
      return {
        content: "No notes yet. Use notes_write to create one.",
        outputs: { notes: [], count: 0 },
      };
    }

    // Prune expired entries on read
    const now = new Date().toISOString();
    let entries = data.entries.filter((e) => !e.expires || e.expires > now);

    // Filter by tag if requested
    if (tag) {
      entries = entries.filter((e) => e.tags?.includes(tag));
    }

    if (entries.length === 0) {
      return {
        content: tag ? `No notes with tag '${tag}'.` : "No active notes (all expired).",
        outputs: { notes: [], count: 0 },
      };
    }

    const lines = entries.map((e) => {
      const parts = [`[${e.id}] ${e.content}`];
      if (e.tags?.length) parts.push(`  tags: ${e.tags.join(", ")}`);
      if (e.expires) parts.push(`  expires: ${e.expires}`);
      return parts.join("\n");
    });

    return {
      content: `${entries.length} note(s):\n\n${lines.join("\n\n")}`,
      outputs: { notes: entries, count: entries.length },
    };
  } catch (err) {
    return { content: `Error reading notes: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── notes_write ─────────────────────────────────────────

async function handleNotesWrite(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const action = (params.action as string | undefined) ?? "add";
  const content = params.content as string | undefined;
  const noteId = params.id as string | undefined;
  const tags = params.tags as string[] | undefined;
  const expires = params.expires as string | undefined;

  try {
    const path = notesPath();
    const data = (await readJson(path) as NotesFile) ?? { entries: [] };

    // Prune expired entries
    const now = new Date().toISOString();
    data.entries = data.entries.filter((e) => !e.expires || e.expires > now);

    switch (action) {
      case "add": {
        if (!content) {
          return { content: "The 'content' parameter is required for action 'add'.", isError: true };
        }
        const entry: NoteEntry = {
          id: noteId ?? randomUUID().slice(0, 8),
          content,
          created: now,
        };
        if (tags?.length) entry.tags = tags;
        if (expires) entry.expires = expires;

        data.entries.push(entry);
        await writeJson(path, data);
        return {
          content: `Note added [${entry.id}]: "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`,
          outputs: { action: "add", id: entry.id },
        };
      }

      case "update": {
        if (!noteId) {
          return { content: "The 'id' parameter is required for action 'update'.", isError: true };
        }
        const existing = data.entries.find((e) => e.id === noteId);
        if (!existing) {
          return { content: `Note '${noteId}' not found.`, isError: true };
        }
        if (content !== undefined) existing.content = content;
        if (tags !== undefined) existing.tags = tags;
        if (expires !== undefined) existing.expires = expires;

        await writeJson(path, data);
        return {
          content: `Note '${noteId}' updated.`,
          outputs: { action: "update", id: noteId },
        };
      }

      case "delete": {
        if (!noteId) {
          return { content: "The 'id' parameter is required for action 'delete'.", isError: true };
        }
        const before = data.entries.length;
        data.entries = data.entries.filter((e) => e.id !== noteId);
        if (data.entries.length === before) {
          return { content: `Note '${noteId}' not found.`, isError: true };
        }

        await writeJson(path, data);
        return {
          content: `Note '${noteId}' deleted.`,
          outputs: { action: "delete", id: noteId },
        };
      }

      default:
        return { content: `Unknown action '${action}'. Use 'add', 'update', or 'delete'.`, isError: true };
    }
  } catch (err) {
    return { content: `Error writing notes: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── user_profile_read ───────────────────────────────────

async function handleUserProfileRead(
  _params: Record<string, unknown>,
): Promise<HandlerResult> {
  try {
    const data = await readJson(userProfilePath());
    if (!data) {
      return {
        content: "No user_profile.json found. Use user_profile_update to create one.",
        outputs: { profile: {} },
      };
    }
    return {
      content: JSON.stringify(data, null, 2),
      outputs: { profile: data as Record<string, unknown> },
    };
  } catch (err) {
    return { content: `Error reading user_profile.json: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── user_profile_update ─────────────────────────────────

async function handleUserProfileUpdate(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const updates = params.updates as Record<string, unknown> | undefined;
  if (!updates || typeof updates !== "object") {
    return { content: "The 'updates' parameter must be an object with fields to set/merge.", isError: true };
  }

  try {
    const path = userProfilePath();
    const existing = (await readJson(path) as Record<string, unknown>) ?? {};

    // Shallow merge — same semantics as identity_update
    const merged = { ...existing, ...updates };

    await writeJson(path, merged);

    const changedKeys = Object.keys(updates);
    logger.info({ changedKeys }, "user_profile.json updated by agent");
    return {
      content: `Updated user_profile.json — changed: ${changedKeys.join(", ")}`,
      outputs: { profile: merged, updated_keys: changedKeys },
    };
  } catch (err) {
    return { content: `Error updating user_profile.json: ${formatErrorMessage(err)}`, isError: true };
  }
}

// ── Task list types ────────────────────────────────────

interface TaskItem {
  id: string;
  text: string;
  done: boolean;
  created: string;
  completed?: string;
}

interface TaskList {
  id: string;
  title: string;
  items: TaskItem[];
  created: string;
  updated: string;
}

interface TasksFile {
  lists: TaskList[];
}

// ── tasks_manage ───────────────────────────────────────

async function handleTasksManage(
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const action = params.action as string | undefined;
  if (!action) {
    return { content: "The 'action' parameter is required. Use: create_list, add_item, check, uncheck, remove_item, delete_list, or list.", isError: true };
  }

  try {
    const path = tasksPath();
    const data = (await readJson(path) as TasksFile) ?? { lists: [] };

    switch (action) {
      case "create_list": {
        const title = params.title as string | undefined;
        if (!title) return { content: "'title' is required for create_list.", isError: true };

        const listId = params.id as string ?? randomUUID().slice(0, 8);
        if (data.lists.find((l) => l.id === listId)) {
          return { content: `List '${listId}' already exists. Use a different ID or delete it first.`, isError: true };
        }

        const now = new Date().toISOString();
        const list: TaskList = { id: listId, title, items: [], created: now, updated: now };

        // Optionally pre-populate with items
        const items = params.items as string[] | undefined;
        if (Array.isArray(items)) {
          for (const text of items) {
            list.items.push({
              id: randomUUID().slice(0, 8),
              text: String(text),
              done: false,
              created: now,
            });
          }
        }

        data.lists.push(list);
        await writeJson(path, data);

        const itemCount = list.items.length;
        return {
          content: `Created list "${title}" [${listId}] with ${itemCount} item(s).`,
          outputs: { action: "create_list", list_id: listId },
        };
      }

      case "add_item": {
        const listId = params.listId as string ?? params.list_id as string;
        const text = params.text as string | undefined;
        if (!listId) return { content: "'listId' is required for add_item.", isError: true };
        if (!text) return { content: "'text' is required for add_item.", isError: true };

        const list = findList(data, listId);
        if (!list) return { content: `List '${listId}' not found.`, isError: true };

        const now = new Date().toISOString();
        const item: TaskItem = {
          id: params.itemId as string ?? randomUUID().slice(0, 8),
          text,
          done: false,
          created: now,
        };
        list.items.push(item);
        list.updated = now;
        await writeJson(path, data);
        return {
          content: `Added to "${list.title}": [ ] ${text}`,
          outputs: { action: "add_item", list_id: list.id, item_id: item.id },
        };
      }

      case "check": {
        const listId = params.listId as string ?? params.list_id as string;
        const itemId = params.itemId as string ?? params.item_id as string;
        if (!listId || !itemId) return { content: "'listId' and 'itemId' are required for check.", isError: true };

        const list = findList(data, listId);
        if (!list) return { content: `List '${listId}' not found.`, isError: true };

        const item = list.items.find((i) => i.id === itemId);
        if (!item) return { content: `Item '${itemId}' not found in list '${listId}'.`, isError: true };

        item.done = true;
        item.completed = new Date().toISOString();
        list.updated = new Date().toISOString();
        await writeJson(path, data);

        const remaining = list.items.filter((i) => !i.done).length;
        return {
          content: `Checked off: [x] ${item.text} (${remaining} remaining in "${list.title}")`,
          outputs: { action: "check", list_id: list.id, item_id: item.id },
        };
      }

      case "uncheck": {
        const listId = params.listId as string ?? params.list_id as string;
        const itemId = params.itemId as string ?? params.item_id as string;
        if (!listId || !itemId) return { content: "'listId' and 'itemId' are required for uncheck.", isError: true };

        const list = findList(data, listId);
        if (!list) return { content: `List '${listId}' not found.`, isError: true };

        const item = list.items.find((i) => i.id === itemId);
        if (!item) return { content: `Item '${itemId}' not found in list '${listId}'.`, isError: true };

        item.done = false;
        item.completed = undefined;
        list.updated = new Date().toISOString();
        await writeJson(path, data);
        return {
          content: `Unchecked: [ ] ${item.text}`,
          outputs: { action: "uncheck", list_id: list.id, item_id: item.id },
        };
      }

      case "remove_item": {
        const listId = params.listId as string ?? params.list_id as string;
        const itemId = params.itemId as string ?? params.item_id as string;
        if (!listId || !itemId) return { content: "'listId' and 'itemId' are required for remove_item.", isError: true };

        const list = findList(data, listId);
        if (!list) return { content: `List '${listId}' not found.`, isError: true };

        const before = list.items.length;
        list.items = list.items.filter((i) => i.id !== itemId);
        if (list.items.length === before) {
          return { content: `Item '${itemId}' not found in list '${listId}'.`, isError: true };
        }

        list.updated = new Date().toISOString();
        await writeJson(path, data);
        return {
          content: `Removed item '${itemId}' from "${list.title}".`,
          outputs: { action: "remove_item", list_id: list.id, item_id: itemId },
        };
      }

      case "delete_list": {
        const listId = params.listId as string ?? params.list_id as string ?? params.id as string;
        if (!listId) return { content: "'listId' is required for delete_list.", isError: true };

        const before = data.lists.length;
        data.lists = data.lists.filter((l) => l.id !== listId);
        if (data.lists.length === before) {
          return { content: `List '${listId}' not found.`, isError: true };
        }

        await writeJson(path, data);
        return {
          content: `Deleted list '${listId}'.`,
          outputs: { action: "delete_list", list_id: listId },
        };
      }

      case "list": {
        if (data.lists.length === 0) {
          return {
            content: "No task lists. Use action 'create_list' to create one.",
            outputs: { action: "list", lists: [] },
          };
        }

        // If a specific list is requested, show its items
        const listId = params.listId as string ?? params.list_id as string;
        if (listId) {
          const list = findList(data, listId);
          if (!list) return { content: `List '${listId}' not found.`, isError: true };
          return {
            content: formatTaskList(list),
            outputs: { action: "list", list_id: list.id, lists: [list] },
          };
        }

        // Otherwise show all lists
        const lines = data.lists.map(formatTaskList);
        return {
          content: lines.join("\n\n"),
          outputs: { action: "list", lists: data.lists },
        };
      }

      default:
        return {
          content: `Unknown action '${action}'. Use: create_list, add_item, check, uncheck, remove_item, delete_list, or list.`,
          isError: true,
        };
    }
  } catch (err) {
    return { content: `Error managing tasks: ${formatErrorMessage(err)}`, isError: true };
  }
}

function findList(data: TasksFile, id: string): TaskList | undefined {
  return data.lists.find((l) => l.id === id);
}

function formatTaskList(list: TaskList): string {
  const done = list.items.filter((i) => i.done).length;
  const total = list.items.length;
  const header = `**${list.title}** [${list.id}] (${done}/${total} done)`;

  if (total === 0) return `${header}\n  (empty)`;

  const items = list.items.map((i) => {
    const check = i.done ? "x" : " ";
    return `  - [${check}] ${i.text} (${i.id})`;
  });

  return `${header}\n${items.join("\n")}`;
}

// ── Prompt builders (for system prompt injection) ───────

/**
 * Load notes.json and build a prompt section with active notes.
 * Returns empty string if no notes exist.
 */
export async function buildNotesPromptSection(workspaceRoot: string): Promise<string> {
  try {
    const path = join(workspaceRoot, ".crabmeat", "notes.json");
    const data = await readJson(path) as NotesFile | null;
    if (!data?.entries?.length) return "";

    const now = new Date().toISOString();
    const active = data.entries.filter((e) => !e.expires || e.expires > now);
    if (active.length === 0) return "";

    const lines = active.map((e) => {
      const tagStr = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
      return `- ${e.content}${tagStr}`;
    });

    return `[AGENT NOTES]\nThese are notes you previously saved. Use them as context:\n${lines.join("\n")}`;
  } catch (err) {
    // Missing file is expected (returns empty prompt section) — but a corrupt
    // or unreadable notes.json would otherwise silently drop user context
    // from the prompt with no trace. Surface it at debug so an operator
    // tracing "why did my notes disappear" can find it.
    const msg = formatErrorMessage(err);
    if (!msg.includes("ENOENT")) {
      logger.debug({ err: msg, section: "notes" }, "Failed to build notes prompt section");
    }
    return "";
  }
}

/**
 * Load user_profile.json and build a prompt section.
 * Returns empty string if no profile exists.
 */
export async function buildUserProfilePromptSection(workspaceRoot: string): Promise<string> {
  try {
    const path = join(workspaceRoot, ".crabmeat", "user_profile.json");
    const data = await readJson(path) as Record<string, unknown> | null;
    if (!data) return "";

    const parts: string[] = ["[USER PROFILE]", "Observations you have made about this user:"];

    if (data.name) parts.push(`Name: ${data.name}`);
    if (data.communicationStyle) parts.push(`Communication style: ${data.communicationStyle}`);
    if (Array.isArray(data.interests) && data.interests.length) parts.push(`Interests: ${(data.interests as string[]).join(", ")}`);

    // Location — surfaced explicitly so phrases like "in my area",
    // "near me", or "what's the weather here" resolve to a real place
    // instead of asking the user every time.
    if (data.location && typeof data.location === "object") {
      const loc = data.location as Record<string, unknown>;
      const where = [loc.city, loc.region, loc.country]
        .filter((v) => typeof v === "string" && v.length > 0)
        .join(", ");
      if (where) {
        const tz = typeof loc.timezone === "string" ? ` (timezone: ${loc.timezone})` : "";
        parts.push(`Location: ${where}${tz}`);
        parts.push(`  When the user says "in my area", "near me", "around here", or similar, treat this as their location for searches and recommendations. Do not ask them to specify it again unless they explicitly say they're somewhere else.`);
      }
    }

    if (Array.isArray(data.observedPatterns) && data.observedPatterns.length) {
      parts.push("Observed patterns:");
      for (const p of data.observedPatterns as string[]) {
        parts.push(`  - ${p}`);
      }
    }
    if (data.notes) parts.push(`Notes: ${data.notes}`);

    // Include any extra keys the agent may have added
    const knownKeys = new Set(["name", "communicationStyle", "interests", "observedPatterns", "notes", "location"]);
    for (const [key, value] of Object.entries(data)) {
      if (!knownKeys.has(key) && value !== null && value !== undefined) {
        parts.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }

    return parts.length > 2 ? parts.join("\n") : "";
  } catch (err) {
    const msg = formatErrorMessage(err);
    if (!msg.includes("ENOENT")) {
      logger.debug({ err: msg, section: "user_profile" }, "Failed to build user profile prompt section");
    }
    return "";
  }
}

// ── Tasks prompt builder ──────────────────────────────

/**
 * Load tasks.json and build a prompt section with active (incomplete) task lists.
 * Returns empty string if no tasks exist or all are complete.
 */
export async function buildTasksPromptSection(workspaceRoot: string): Promise<string> {
  try {
    const path = join(workspaceRoot, ".crabmeat", "tasks.json");
    const data = await readJson(path) as TasksFile | null;
    if (!data?.lists?.length) return "";

    // Only include lists with at least one incomplete item
    const activeLists = data.lists.filter((l) => l.items.some((i) => !i.done));
    if (activeLists.length === 0) return "";

    const sections = activeLists.map(formatTaskList);
    return `[ACTIVE TASKS]\nYou have pending task lists. Check items off as you complete them using tasks_manage:\n${sections.join("\n\n")}`;
  } catch (err) {
    const msg = formatErrorMessage(err);
    if (!msg.includes("ENOENT")) {
      logger.debug({ err: msg, section: "tasks" }, "Failed to build tasks prompt section");
    }
    return "";
  }
}

// ── Registration ────────────────────────────────────────

export function registerAgentDataTools(): void {
  registerToolHandler("identity_read", handleIdentityRead);
  registerToolHandler("identity_update", handleIdentityUpdate);
  registerToolHandler("notes_read", handleNotesRead);
  registerToolHandler("notes_write", handleNotesWrite);
  registerToolHandler("user_profile_read", handleUserProfileRead);
  registerToolHandler("user_profile_update", handleUserProfileUpdate);
  registerToolHandler("tasks_manage", handleTasksManage);

  registerPromptFragment({
    id: "tool:tasks_manage",
    category: "tool",
    predicate: (ctx) => ctx.tools.includes("tasks_manage"),
    order: 30,
    content: [
      "TASK TRACKING: When given a complex task (research, reports, multi-file",
      "operations), ALWAYS:",
      "1. Create a task list with tasks_manage (action: create_list, with items)",
      "2. Work through each item, checking it off as you go (action: check)",
      "3. If you can't finish, the unchecked items persist for next session",
      "This is critical — without a task list, you lose track of multi-step work.",
    ].join("\n"),
  });

  registerPromptFragment({
    id: "tool:self-awareness",
    category: "tool",
    // Applies whenever any of the identity/notes/user-profile tools are
    // in play — they co-evolve; if the agent has one it usually has all.
    predicate: (ctx) =>
      ctx.tools.includes("identity_read") ||
      ctx.tools.includes("identity_update") ||
      ctx.tools.includes("notes_read") ||
      ctx.tools.includes("notes_write") ||
      ctx.tools.includes("user_profile_read") ||
      ctx.tools.includes("user_profile_update"),
    order: 40,
    content: [
      "SELF-AWARENESS: You have a persistent identity (AGENT.json), notes",
      "(notes.json), and user observations (user_profile.json). Proactively",
      "update these as you learn:",
      "- When you notice the user's communication style or preferences, update user_profile.",
      "- When the user asks you to remember something, save a note.",
      "- When you develop a sense of your own personality or the user gives you a name, update your identity.",
      "Do NOT update these every message — only when you genuinely learn",
      "something new or the user explicitly asks.",
    ].join("\n"),
  });

  logger.info(
    { tools: ["identity_read", "identity_update", "notes_read", "notes_write", "user_profile_read", "user_profile_update", "tasks_manage"] },
    "Agent data tool handlers registered",
  );
}
