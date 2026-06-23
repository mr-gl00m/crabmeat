import { describe, it, expect, beforeEach } from "vitest";
import {
  registerOutboundMirrorSink,
  unregisterOutboundMirrorSink,
  emitOutboundMirror,
  _resetOutboundMirror,
  _mirrorSinkCount,
  type OutboundMirrorEvent,
} from "./message-mirror-broker.js";

function makeEvent(
  overrides: Partial<OutboundMirrorEvent> = {},
): OutboundMirrorEvent {
  return {
    sessionKey: "s1",
    messageId: "msg-1",
    channel: "discord",
    content: "hi",
    delivered: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetOutboundMirror();
});

describe("message-mirror-broker", () => {
  it("delivers events to the registered sink", () => {
    const received: OutboundMirrorEvent[] = [];
    registerOutboundMirrorSink("s1", (e) => received.push(e));
    emitOutboundMirror(makeEvent());
    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe("discord");
  });

  it("swallows sink throws so the caller is never broken", () => {
    registerOutboundMirrorSink("s1", () => {
      throw new Error("boom");
    });
    expect(() => emitOutboundMirror(makeEvent())).not.toThrow();
  });

  it("no-op when no sink is registered for the session", () => {
    expect(() => emitOutboundMirror(makeEvent({ sessionKey: "s2" }))).not.toThrow();
  });

  it("sessions are isolated — other sinks do not receive", () => {
    const a: OutboundMirrorEvent[] = [];
    const b: OutboundMirrorEvent[] = [];
    registerOutboundMirrorSink("sA", (e) => a.push(e));
    registerOutboundMirrorSink("sB", (e) => b.push(e));
    emitOutboundMirror(makeEvent({ sessionKey: "sA" }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("registering twice replaces the sink", () => {
    const first: OutboundMirrorEvent[] = [];
    const second: OutboundMirrorEvent[] = [];
    registerOutboundMirrorSink("s1", (e) => first.push(e));
    registerOutboundMirrorSink("s1", (e) => second.push(e));
    emitOutboundMirror(makeEvent());
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it("unregister stops delivery", () => {
    const received: OutboundMirrorEvent[] = [];
    registerOutboundMirrorSink("s1", (e) => received.push(e));
    unregisterOutboundMirrorSink("s1");
    emitOutboundMirror(makeEvent());
    expect(received).toHaveLength(0);
  });

  it("_mirrorSinkCount reflects current state", () => {
    expect(_mirrorSinkCount()).toBe(0);
    registerOutboundMirrorSink("sA", () => {});
    registerOutboundMirrorSink("sB", () => {});
    expect(_mirrorSinkCount()).toBe(2);
    unregisterOutboundMirrorSink("sA");
    expect(_mirrorSinkCount()).toBe(1);
  });
});
