import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import {
  setKillUrlBase,
  _resetMessageSendRate,
  MAX_MESSAGE_CONTENT_LEN,
  MAX_CHANNELS_PER_CALL,
} from "./message-send.js";
import {
  registerOutboundConnector,
  _resetOutboundRegistry,
  type OutboundConnector,
  type OutboundDeliverOptions,
  type OutboundDeliverResult,
} from "../../connectors/outbound.js";
import {
  registerOutboundMirrorSink,
  _resetOutboundMirror,
  type OutboundMirrorEvent,
} from "./message-mirror-broker.js";
import {
  _resetKillTokens,
  _killTokenCount,
  KILL_TOKEN_BYTE_LEN,
} from "../../security/kill-tokens.js";
import type { ToolExecutionContext } from "./types.js";

interface CapturedCall {
  opts: OutboundDeliverOptions;
}

function makeRecorder(id: string, result: OutboundDeliverResult = { ok: true }) {
  const calls: CapturedCall[] = [];
  const connector: OutboundConnector = {
    id,
    name: id,
    trustLevel: "trusted",
    async deliver(opts) {
      calls.push({ opts });
      return result;
    },
  };
  return { connector, calls };
}

function makeThrower(id: string, errMsg = "kaboom") {
  const connector: OutboundConnector = {
    id,
    name: id,
    trustLevel: "trusted",
    async deliver() {
      throw new Error(errMsg);
    },
  };
  return connector;
}

beforeAll(() => {
  registerBuiltinTools();
});

beforeEach(() => {
  _resetOutboundRegistry();
  _resetOutboundMirror();
  _resetKillTokens();
  _resetMessageSendRate();
  setKillUrlBase("");
});

const ctx = (sessionKey = "s1"): ToolExecutionContext => ({
  sessionKey,
  agentId: "default",
});

describe("message_send tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("message_send")).toBe(true);
  });

  it("errors without a session context", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler({ content: "hi", channels: ["discord"] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("active user session");
  });

  it("errors on empty content", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "   ", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'content' is required");
  });

  it("errors on overlong content", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "x".repeat(MAX_MESSAGE_CONTENT_LEN + 1), channels: ["d"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too long");
  });

  it("errors on non-array channels", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: "discord" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must be an array");
  });

  it("errors on empty channels array", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: [] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("at least one");
  });

  it("errors when too many channels", async () => {
    const handler = getToolHandler("message_send");
    const tooMany = Array.from(
      { length: MAX_CHANNELS_PER_CALL + 1 },
      (_, i) => `c${i}`,
    );
    const res = await handler(
      { content: "hi", channels: tooMany },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too many channels");
  });

  it("errors on duplicate channels", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["d", "d"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("duplicate");
  });

  it("errors on empty channel string", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: [""] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("non-empty string");
  });

  it("errors when reason is not a string", async () => {
    const { connector } = makeRecorder("discord");
    registerOutboundConnector(connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord"], reason: 42 },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'reason' must be a string");
  });

  it("errors when a requested channel has no connector", async () => {
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no outbound connector");
    expect(_killTokenCount()).toBe(0); // no token issued on up-front failure
  });

  it("delivers to a registered connector and issues a kill token", async () => {
    setKillUrlBase("https://example.test");
    const rec = makeRecorder("discord");
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hello world", channels: ["discord"], reason: "testing" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.opts.content).toBe("hello world");
    expect(rec.calls[0]!.opts.reason).toBe("testing");
    expect(rec.calls[0]!.opts.killUrl).toContain(
      "https://example.test/admin/kill-token?t=",
    );
    const token = rec.calls[0]!.opts.killUrl.split("t=")[1]!;
    expect(token.length).toBe(KILL_TOKEN_BYTE_LEN * 2);
    expect(res.content).toContain("1/1 delivered");
    expect(res.content).toContain("kill link");
  });

  it("omits kill link when no base URL is configured", async () => {
    const rec = makeRecorder("discord");
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(rec.calls[0]!.opts.killUrl).toBe("");
    expect(res.content).not.toContain("kill link");
  });

  it("delivers to multiple channels and aggregates results", async () => {
    setKillUrlBase("https://example.test");
    const a = makeRecorder("discord");
    const b = makeRecorder("telegram");
    registerOutboundConnector(a.connector);
    registerOutboundConnector(b.connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "ping", channels: ["discord", "telegram"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(res.content).toContain("2/2 delivered");
    // Same kill token reused across the whole dispatch
    expect(a.calls[0]!.opts.killUrl).toBe(b.calls[0]!.opts.killUrl);
  });

  it("mirrors every send to the CLI sink", async () => {
    const rec = makeRecorder("discord");
    registerOutboundConnector(rec.connector);
    const received: OutboundMirrorEvent[] = [];
    registerOutboundMirrorSink("s1", (e) => received.push(e));
    const handler = getToolHandler("message_send");
    await handler(
      { content: "hi", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe("discord");
    expect(received[0]!.content).toBe("hi");
    expect(received[0]!.delivered).toBe(true);
  });

  it("marks result as error when all deliveries fail", async () => {
    registerOutboundConnector(makeThrower("discord"));
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("0/1 delivered");
    expect(res.content).toContain("kaboom");
  });

  it("partial success is not marked as error", async () => {
    const ok = makeRecorder("ok");
    registerOutboundConnector(ok.connector);
    registerOutboundConnector(makeThrower("bad"));
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["ok", "bad"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("1/2 delivered");
  });

  it("connector returning ok=false surfaces the error", async () => {
    const rec = makeRecorder("discord", {
      ok: false,
      error: "rate limited",
    });
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("rate limited");
  });

  it("issues exactly one kill token per call regardless of channel count", async () => {
    setKillUrlBase("https://example.test");
    const a = makeRecorder("a");
    const b = makeRecorder("b");
    const c = makeRecorder("c");
    registerOutboundConnector(a.connector);
    registerOutboundConnector(b.connector);
    registerOutboundConnector(c.connector);
    const handler = getToolHandler("message_send");
    await handler(
      { content: "hi", channels: ["a", "b", "c"] },
      undefined,
      ctx(),
    );
    // One call → one token (already redeemable because nothing redeemed yet)
    expect(_killTokenCount()).toBe(1);
  });

  it("rate-limits after MAX sends per minute", async () => {
    const rec = makeRecorder("d");
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    let lastRes: Awaited<ReturnType<typeof handler>> | undefined;
    for (let i = 0; i < 11; i++) {
      lastRes = await handler(
        { content: "hi", channels: ["d"] },
        undefined,
        ctx(),
      );
    }
    expect(lastRes!.isError).toBe(true);
    expect(lastRes!.content).toContain("rate-limited");
  });

  it("rate limit is per-session", async () => {
    const rec = makeRecorder("d");
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    // Exhaust session A
    for (let i = 0; i < 10; i++) {
      await handler({ content: "hi", channels: ["d"] }, undefined, ctx("sA"));
    }
    // Session B is untouched
    const res = await handler(
      { content: "hi", channels: ["d"] },
      undefined,
      ctx("sB"),
    );
    expect(res.isError).toBeFalsy();
  });

  it("unknown channel fails up front without issuing a token or calling deliver", async () => {
    const rec = makeRecorder("discord");
    registerOutboundConnector(rec.connector);
    const handler = getToolHandler("message_send");
    const res = await handler(
      { content: "hi", channels: ["discord", "missing"] },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("missing");
    expect(rec.calls).toHaveLength(0);
    expect(_killTokenCount()).toBe(0);
  });
});
