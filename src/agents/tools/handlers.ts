import type { ToolExecuteHandler } from "./types.js";

const registry = new Map<string, ToolExecuteHandler>();

/**
 * Register an execute handler for a tool.
 * Handlers contain the actual implementation logic.
 */
export function registerToolHandler(
  toolId: string,
  handler: ToolExecuteHandler,
): void {
  registry.set(toolId, handler);
}

/**
 * Get the execute handler for a tool.
 * Returns a default handler that reports "not implemented" if none is registered.
 */
export function getToolHandler(toolId: string): ToolExecuteHandler {
  return (
    registry.get(toolId) ??
    (async () => ({
      content: `Tool '${toolId}' has no registered handler.`,
      isError: true,
    }))
  );
}

/**
 * Check if a handler is registered for a tool.
 */
export function hasToolHandler(toolId: string): boolean {
  return registry.has(toolId);
}

/**
 * Clear all registered handlers (for testing).
 */
export function clearToolHandlers(): void {
  registry.clear();
}
