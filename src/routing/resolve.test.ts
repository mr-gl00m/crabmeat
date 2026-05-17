import { describe, it, expect } from "vitest";
import { resolveRoute } from "./resolve.js";
import type { RoutingConfig } from "../config/types.js";

describe("resolveRoute", () => {
  const config: RoutingConfig = {
    defaultAgentId: "default-agent",
    bindings: [
      { channel: "support", agentId: "support-agent" },
    ],
  };

  it("resolves to the correct agent via binding", () => {
    const result = resolveRoute({ channelId: "support" }, config);
    expect(result.agentId).toBe("support-agent");
    expect(result.sessionKey).toMatch(/^[a-f0-9]{24}$/);
  });

  it("falls back to default agent", () => {
    const result = resolveRoute({ channelId: "general" }, config);
    expect(result.agentId).toBe("default-agent");
  });

  it("produces deterministic session keys", () => {
    const a = resolveRoute({ channelId: "support", peerId: "p1" }, config);
    const b = resolveRoute({ channelId: "support", peerId: "p1" }, config);
    expect(a.sessionKey).toBe(b.sessionKey);
  });

  it("produces different keys for different contexts", () => {
    const a = resolveRoute({ channelId: "support", peerId: "p1" }, config);
    const b = resolveRoute({ channelId: "support", peerId: "p2" }, config);
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });
});
