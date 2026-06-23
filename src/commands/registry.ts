/**
 * Slash command registry.
 *
 * Slash commands are user-facing commands that bypass the LLM entirely.
 * They're intercepted at the protocol level before any inference happens.
 *
 * Commands are prefixed with '/' in chat.send content. The handler
 * detects the prefix, looks up the command, and executes it directly,
 * sending results back through the ConnectorSink.
 */

import type { ConnectorSink } from "../connectors/types.js";
import type { Config } from "../config/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { InferencePipeline } from "../agents/inference.js";
import type { CircuitBreaker } from "../security/circuit-breaker.js";

export interface CommandContext {
  sink: ConnectorSink;
  sessionKey: string;
  frameId: string;
  config: Config;
  store: SessionStore;
  pipeline: InferencePipeline;
  circuitBreaker?: CircuitBreaker;
  /** Raw arguments after the command name. */
  args: string;
}

export interface CommandResult {
  /** Text to send back to the user as a chat.token stream. */
  output: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

const commands = new Map<string, CommandDefinition>();

export function registerCommand(def: CommandDefinition): void {
  commands.set(def.name.toLowerCase(), def);
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name.toLowerCase());
}

export function listCommands(): CommandDefinition[] {
  return [...commands.values()];
}

/**
 * Check if a message is a slash command.
 * Returns the command name and args, or null if not a command.
 */
export function parseSlashCommand(content: string): { name: string; args: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}
