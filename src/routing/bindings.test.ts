import { describe, it, expect } from "vitest";
import { matchBinding } from "./bindings.js";
import type { RoutingConfig } from "../config/types.js";

function makeConfig(
  bindings: RoutingConfig["bindings"],
  defaultAgentId = "default-agent",
): RoutingConfig {
  return { defaultAgentId, bindings };
}

describe("matchBinding", () => {
  it("returns default agent when no bindings exist", () => {
    const result = matchBinding({ channelId: "chan-1" }, makeConfig([]));
    expect(result).toBe("default-agent");
  });

  it("matches binding with exact channel", () => {
    const config = makeConfig([
      { channel: "support", agentId: "support-agent" },
    ]);
    expect(matchBinding({ channelId: "support" }, config)).toBe("support-agent");
  });

  it("matches binding with exact peer", () => {
    const config = makeConfig([
      { peer: "user-42", agentId: "vip-agent" },
    ]);
    expect(matchBinding({ peerId: "user-42" }, config)).toBe("vip-agent");
  });

  it("matches binding with both channel and peer", () => {
    const config = makeConfig([
      { channel: "support", peer: "user-42", agentId: "vip-support" },
    ]);
    expect(
      matchBinding({ channelId: "support", peerId: "user-42" }, config),
    ).toBe("vip-support");
  });

  it("uses first match (order matters)", () => {
    const config = makeConfig([
      { channel: "support", agentId: "first" },
      { channel: "support", agentId: "second" },
    ]);
    expect(matchBinding({ channelId: "support" }, config)).toBe("first");
  });

  it("falls back to default when no binding matches", () => {
    const config = makeConfig([
      { channel: "support", agentId: "support-agent" },
    ]);
    expect(matchBinding({ channelId: "sales" }, config)).toBe("default-agent");
  });

  it("binding without channel matches any channel", () => {
    const config = makeConfig([
      { peer: "user-42", agentId: "vip-agent" },
    ]);
    expect(
      matchBinding({ channelId: "anything", peerId: "user-42" }, config),
    ).toBe("vip-agent");
  });

  it("binding without peer matches any peer", () => {
    const config = makeConfig([
      { channel: "support", agentId: "support-agent" },
    ]);
    expect(
      matchBinding({ channelId: "support", peerId: "anyone" }, config),
    ).toBe("support-agent");
  });
});
