export interface TrustMeta {
  source: "user_input" | "tool_result" | "system" | "assistant";
  sigilDetections: string[];
  normalized: boolean;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  trust: TrustMeta;
  messageId: string;
}

export interface SessionCostMetrics {
  totalUsd: number;
  turnsPriced: number;
  turnsUnpriced: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
}

export interface Session {
  sessionKey: string;
  agentId: string;
  channelId?: string;
  peerId?: string;
  transcript: TranscriptEntry[];
  createdAt: string;
  updatedAt: string;

  /**
   * Trust role of the caller for this session. "owner" = direct CLI/WS
   * from the operator (default), "shell" = future Hermes UI, "external"
   * = future webhook inbound. Drives owner-only tool routing in
   * src/security/owner-only-tools.ts. Optional on the type so legacy
   * persisted sessions load cleanly — absent is treated as "owner" in
   * the routing path.
   */
  callerRole?: "owner" | "shell" | "external";

  /**
   * Running per-session cost state. Populated as turns complete via
   * the cost tracker. Optional on the type so legacy persisted sessions
   * (written before the tracker existed) load cleanly — the first turn
   * after reload repopulates it via `createEmptyCostMetrics`.
   */
  costMetrics?: SessionCostMetrics;

  /** Runtime overrides for Layer 2, scoped to this session. Resets on disconnect. */
  layer2Override?: { enabled?: boolean };

  /**
   * "Away" state set via /away. When enabled, the per-turn dynamic prompt
   * region tells the model the user is not at the CLI and that the final
   * response of the turn should be delivered via message_send to the
   * preferred outbound connector. Cleared by /back.
   */
  awayMode?: {
    enabled: boolean;
    /** Connector id (e.g. "discord") to deliver the final response to. */
    preferredConnector?: string;
    /** ISO timestamp when /away was issued. */
    setAt?: string;
    /** Free-form note from the user (e.g. "in a meeting until 3"). */
    reason?: string;
  };
}
