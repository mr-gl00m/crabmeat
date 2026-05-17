import { describe, it, expect, beforeEach } from "vitest";
import { checkTrustGate, enforceTrustGate } from "./trust-gate.js";
import { resetEscalationManager, getEscalationManager } from "./escalation.js";
import type { ConnectorSink } from "../connectors/types.js";

beforeEach(() => {
  resetEscalationManager();
});

// ── Static gate ─────────────────────────────────────────────

describe("checkTrustGate", () => {
  it("allows read for untrusted", () => {
    expect(checkTrustGate("untrusted", "read")).toEqual({ action: "allow" });
  });

  it("requires escalation for write from untrusted", () => {
    const result = checkTrustGate("untrusted", "write");
    expect(result.action).toBe("escalate");
  });

  it("allows write for standard", () => {
    expect(checkTrustGate("standard", "write")).toEqual({ action: "allow" });
  });

  it("allows network for standard", () => {
    expect(checkTrustGate("standard", "network")).toEqual({ action: "allow" });
  });

  it("requires escalation for exec from standard", () => {
    const result = checkTrustGate("standard", "exec");
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.requiredLevel).toBe("trusted");
    }
  });

  it("allows exec for trusted", () => {
    expect(checkTrustGate("trusted", "exec")).toEqual({ action: "allow" });
  });

  it("requires escalation for privileged from trusted", () => {
    const result = checkTrustGate("trusted", "privileged");
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.requiredLevel).toBe("admin");
    }
  });

  it("allows all effects for admin", () => {
    for (const effect of ["read", "write", "network", "exec", "privileged"] as const) {
      expect(checkTrustGate("admin", effect)).toEqual({ action: "allow" });
    }
  });
});

// ── Full gate with escalation ───────────────────────────────

function makeMockSink(grantPermission: boolean): ConnectorSink {
  return {
    sendToken: () => {},
    sendDone: () => {},
    sendError: () => {},
    sendToolStatus: () => {},
    sendAuditEntry: () => {},
    isOpen: () => true,
    requestPermission: async () => grantPermission,
  };
}

function makeSinkWithoutEscalation(): ConnectorSink {
  return {
    sendToken: () => {},
    sendDone: () => {},
    sendError: () => {},
    sendToolStatus: () => {},
    sendAuditEntry: () => {},
    isOpen: () => true,
    // No requestPermission — escalation unavailable
  };
}

describe("enforceTrustGate", () => {
  it("allows when base trust is sufficient", async () => {
    const sink = makeSinkWithoutEscalation();
    const result = await enforceTrustGate("s1", "admin", "privileged", "dangerous_tool", sink);
    expect(result).toEqual({ action: "allow" });
  });

  it("denies when no escalation path is available", async () => {
    const sink = makeSinkWithoutEscalation();
    const result = await enforceTrustGate("s1", "untrusted", "write", "file_write", sink);
    expect(result.action).toBe("deny");
  });

  it("allows after user grants escalation", async () => {
    const sink = makeMockSink(true);
    const result = await enforceTrustGate("s1", "untrusted", "write", "file_write", sink);
    expect(result).toEqual({ action: "allow" });

    // Escalation should persist for the session
    const mgr = getEscalationManager();
    expect(mgr.getEffectiveLevel("s1", "untrusted")).toBe("standard");
  });

  it("denies when user declines escalation", async () => {
    const sink = makeMockSink(false);
    const result = await enforceTrustGate("s1", "untrusted", "write", "file_write", sink);
    expect(result.action).toBe("deny");
  });

  it("allows on second call after prior escalation grant", async () => {
    const grantSink = makeMockSink(true);
    await enforceTrustGate("s1", "untrusted", "write", "tool_a", grantSink);

    // Second call with a sink that doesn't support escalation should still work
    // because the escalation was already granted
    const noEscSink = makeSinkWithoutEscalation();
    const result = await enforceTrustGate("s1", "untrusted", "write", "tool_b", noEscSink);
    expect(result).toEqual({ action: "allow" });
  });
});
