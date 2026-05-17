import type { RoutingConfig } from "../config/types.js";
import { deriveSessionKey } from "../sessions/session-key.js";
import { matchBinding } from "./bindings.js";
import type { RouteContext, RouteResult } from "./types.js";

/**
 * Resolve a message's routing context to an agent ID and session key.
 */
export function resolveRoute(
  context: RouteContext,
  config: RoutingConfig,
): RouteResult {
  const agentId = matchBinding(context, config);
  const sessionKey = deriveSessionKey(agentId, context.channelId, context.peerId);
  return { agentId, sessionKey };
}
