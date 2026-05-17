import type { RoutingConfig } from "../config/types.js";
import type { RouteContext } from "./types.js";

/**
 * Find the best matching agent for a given route context.
 * Bindings are checked in order; first match wins.
 * Falls back to the default agent if no binding matches.
 */
export function matchBinding(
  context: RouteContext,
  config: RoutingConfig,
): string {
  for (const binding of config.bindings) {
    const channelMatch = !binding.channel || binding.channel === context.channelId;
    const peerMatch = !binding.peer || binding.peer === context.peerId;
    if (channelMatch && peerMatch) {
      return binding.agentId;
    }
  }
  return config.defaultAgentId;
}
