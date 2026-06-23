import { describe, it, expect } from "vitest";
import { matchBinding } from "./bindings.js";
import { resolveRoute } from "./resolve.js";
import { deriveSessionKey } from "../sessions/session-key.js";
import type { RoutingConfig } from "../config/types.js";

describe("routing — empty string vs undefined", () => {
  const config: RoutingConfig = {
    defaultAgentId: "default",
    bindings: [
      { channel: "support", agentId: "support-agent" },
    ],
  };

  it("empty channelId does not match a specific channel binding", () => {
    // "" should NOT match binding with channel="support"
    const result = matchBinding({ channelId: "" }, config);
    expect(result).toBe("default");
  });

  it("undefined channelId does not match a specific channel binding", () => {
    const result = matchBinding({ channelId: undefined }, config);
    expect(result).toBe("default");
  });

  it("empty and undefined channelId produce same session key", () => {
    // deriveSessionKey uses `channelId ?? ""` so both should be identical
    const a = deriveSessionKey("agent", undefined, "peer");
    const b = deriveSessionKey("agent", "", "peer");
    // They're actually different: undefined → "" via ?? but explicit "" → ""
    // Let's verify — this documents the actual behavior
    // session-key.ts: [agentId, channelId ?? "", peerId ?? ""].join("\0")
    // With undefined: "agent\0\0peer"
    // With "": "agent\0\0peer"  — SAME
    expect(a).toBe(b);
  });
});

describe("routing — binding with empty strings", () => {
  it("binding with channel='' matches any channelId", () => {
    const config: RoutingConfig = {
      defaultAgentId: "default",
      bindings: [{ channel: "", agentId: "empty-agent" }],
    };
    // !binding.channel → !"" → true → channelMatch = true
    const result = matchBinding({ channelId: "anything" }, config);
    expect(result).toBe("empty-agent");
  });

  it("binding with peer='' matches any peerId", () => {
    const config: RoutingConfig = {
      defaultAgentId: "default",
      bindings: [{ peer: "", agentId: "empty-agent" }],
    };
    const result = matchBinding({ peerId: "anyone" }, config);
    expect(result).toBe("empty-agent");
  });
});

describe("routing — complex binding resolution", () => {
  it("specific binding takes priority over wildcard", () => {
    const config: RoutingConfig = {
      defaultAgentId: "default",
      bindings: [
        { channel: "vip", peer: "boss", agentId: "vip-boss" },
        { channel: "vip", agentId: "vip-general" },
        { peer: "boss", agentId: "boss-any" },
      ],
    };
    // First matching binding wins
    expect(matchBinding({ channelId: "vip", peerId: "boss" }, config)).toBe("vip-boss");
    expect(matchBinding({ channelId: "vip", peerId: "random" }, config)).toBe("vip-general");
    expect(matchBinding({ channelId: "general", peerId: "boss" }, config)).toBe("boss-any");
    expect(matchBinding({ channelId: "general", peerId: "random" }, config)).toBe("default");
  });

  it("resolveRoute produces unique keys for each agent+context", () => {
    const config: RoutingConfig = {
      defaultAgentId: "default",
      bindings: [
        { channel: "a", agentId: "agent-a" },
        { channel: "b", agentId: "agent-b" },
      ],
    };
    const rA = resolveRoute({ channelId: "a" }, config);
    const rB = resolveRoute({ channelId: "b" }, config);
    expect(rA.agentId).not.toBe(rB.agentId);
    expect(rA.sessionKey).not.toBe(rB.sessionKey);
  });
});
