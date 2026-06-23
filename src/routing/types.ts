export interface RouteResult {
  agentId: string;
  sessionKey: string;
}

export interface RouteContext {
  channelId?: string;
  peerId?: string;
}
