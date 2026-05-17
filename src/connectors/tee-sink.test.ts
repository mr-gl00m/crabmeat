import { describe, it, expect, vi } from "vitest";
import { createTeeSink } from "./tee-sink.js";
import { createBufferSink } from "./buffer-sink.js";
import type { ConnectorSink } from "./types.js";

function spySink(open = true): ConnectorSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendToken(t, k) { calls.push(`token:${t}:${k}`); },
    sendDone(k, m) { calls.push(`done:${k}:${m}`); },
    sendError(c, m) { calls.push(`error:${c}:${m}`); },
    sendToolStatus(k, n, c, s) { calls.push(`tool:${n}:${s}`); },
    sendAuditEntry() { calls.push("audit"); },
    isOpen() { return open; },
  } as ConnectorSink & { calls: string[] };
}

describe("createTeeSink", () => {
  it("fans out sendToken to every underlying sink", () => {
    const a = spySink();
    const b = spySink();
    const tee = createTeeSink([a, b]);
    tee.sendToken("hi", "s1");
    expect(a.calls).toEqual(["token:hi:s1"]);
    expect(b.calls).toEqual(["token:hi:s1"]);
  });

  it("fans out done, error, tool status, audit", () => {
    const a = spySink();
    const b = spySink();
    const tee = createTeeSink([a, b]);
    tee.sendDone("s", "m");
    tee.sendError("E", "msg");
    tee.sendToolStatus("s", "tool", "c", "running");
    tee.sendAuditEntry({} as any);
    expect(a.calls).toEqual(["done:s:m", "error:E:msg", "tool:tool:running", "audit"]);
    expect(b.calls).toEqual(a.calls);
  });

  it("isOpen returns true if any underlying sink is open", () => {
    const closed = spySink(false);
    const open = spySink(true);
    expect(createTeeSink([closed, open]).isOpen()).toBe(true);
    expect(createTeeSink([closed, closed]).isOpen()).toBe(false);
  });

  it("a failing observer does not break delivery to the primary", () => {
    const primary = createBufferSink();
    const broken: ConnectorSink = {
      sendToken() { throw new Error("boom"); },
      sendDone() { throw new Error("boom"); },
      sendError() { throw new Error("boom"); },
      sendToolStatus() { throw new Error("boom"); },
      sendAuditEntry() { throw new Error("boom"); },
      isOpen() { return true; },
    };
    const tee = createTeeSink([primary, broken]);
    tee.sendToken("hello ", "s");
    tee.sendToken("world", "s");
    tee.sendDone("s", "m1");
    expect(primary.getResult().text).toBe("hello world");
    expect(primary.getResult().messageId).toBe("m1");
  });

  it("requestPermission delegates only to the primary sink, not observers", async () => {
    const primary: ConnectorSink = {
      sendToken: vi.fn(), sendDone: vi.fn(), sendError: vi.fn(),
      sendToolStatus: vi.fn(), sendAuditEntry: vi.fn(),
      isOpen: () => true,
      requestPermission: vi.fn(async () => true),
    };
    const observer: ConnectorSink = {
      sendToken: vi.fn(), sendDone: vi.fn(), sendError: vi.fn(),
      sendToolStatus: vi.fn(), sendAuditEntry: vi.fn(),
      isOpen: () => true,
      requestPermission: vi.fn(async () => false),
    };
    const tee = createTeeSink([primary, observer]);
    const result = await tee.requestPermission!("s", "tool", "fs_write", "why");
    expect(result).toBe(true);
    expect(primary.requestPermission).toHaveBeenCalledOnce();
    expect(observer.requestPermission).not.toHaveBeenCalled();
  });

  it("throws if constructed with zero sinks", () => {
    expect(() => createTeeSink([])).toThrow(/at least one/);
  });
});
