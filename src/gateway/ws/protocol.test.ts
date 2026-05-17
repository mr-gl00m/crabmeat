import { describe, it, expect } from "vitest";
import {
  connectFrameSchema,
  chatSendFrameSchema,
  requestFrameSchema,
  makeResponse,
  makeErrorEvent,
  makeTokenEvent,
} from "./protocol.js";

describe("connectFrameSchema", () => {
  it("validates a correct connect frame", () => {
    const frame = {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1, token: "my-token" },
    };
    expect(connectFrameSchema.parse(frame)).toEqual(frame);
  });

  it("rejects wrong protocol version", () => {
    const frame = {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 99 },
    };
    expect(connectFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("allows connect without credentials (for mode=none)", () => {
    const frame = {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    };
    expect(connectFrameSchema.safeParse(frame).success).toBe(true);
  });
});

describe("chatSendFrameSchema", () => {
  it("validates a chat.send frame", () => {
    const frame = {
      id: "2",
      type: "req",
      method: "chat.send",
      params: { content: "Hello!" },
    };
    expect(chatSendFrameSchema.parse(frame)).toMatchObject(frame);
  });

  it("rejects empty content", () => {
    const frame = {
      id: "2",
      type: "req",
      method: "chat.send",
      params: { content: "" },
    };
    expect(chatSendFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("requestFrameSchema (discriminated union)", () => {
  it("parses connect frames", () => {
    const frame = {
      id: "1",
      type: "req",
      method: "connect",
      params: { protocolVersion: 1 },
    };
    const result = requestFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it("parses chat.send frames", () => {
    const frame = {
      id: "2",
      type: "req",
      method: "chat.send",
      params: { content: "hi" },
    };
    const result = requestFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it("rejects unknown methods", () => {
    const frame = {
      id: "3",
      type: "req",
      method: "unknown.method",
      params: {},
    };
    const result = requestFrameSchema.safeParse(frame);
    expect(result.success).toBe(false);
  });
});

describe("frame helpers", () => {
  it("makeResponse creates a valid response", () => {
    const res = makeResponse("req-1", { foo: "bar" });
    expect(res.type).toBe("res");
    expect(res.replyTo).toBe("req-1");
    expect(res.status).toBe("ok");
    expect(res.data).toEqual({ foo: "bar" });
  });

  it("makeErrorEvent creates a valid error event", () => {
    const evt = makeErrorEvent("TEST_ERR", "something broke");
    expect(evt.type).toBe("error");
    expect(evt.error.code).toBe("TEST_ERR");
  });

  it("makeTokenEvent creates a valid token event", () => {
    const evt = makeTokenEvent("Hello", "sess-123");
    expect(evt.type).toBe("event");
    expect(evt.event).toBe("chat.token");
    expect(evt.data.token).toBe("Hello");
  });
});
