import { describe, it, expect } from "vitest";
import { createBufferSink } from "./buffer-sink.js";

describe("BufferSink", () => {
  it("accumulates plain tokens into a single string", () => {
    const sink = createBufferSink();
    sink.sendToken("Hello ");
    sink.sendToken("world");
    expect(sink.getResult().text).toBe("Hello world");
  });

  it("captures messageId from sendDone", () => {
    const sink = createBufferSink();
    sink.sendToken("done");
    sink.sendDone("sk:abc", "msg-123");
    expect(sink.getResult().messageId).toBe("msg-123");
  });

  it("drops pre-tool-call text when a tool call starts", () => {
    // Regression for 2026-04-30 Trump-ballroom incident: the model
    // emitted "We need to call the web_search function..." reasoning
    // BEFORE its tool call, and that reasoning leaked into the email
    // reply alongside the actual final answer.
    const sink = createBufferSink();
    sink.sendToken("We need to call the web_search function...");
    sink.sendToolStatus("sk:test", "web_search", "call_1", "running");
    sink.sendToolStatus("sk:test", "web_search", "call_1", "success");
    sink.sendToken("Here is the actual final answer.");
    expect(sink.getResult().text).toBe("Here is the actual final answer.");
  });

  it("only keeps text emitted AFTER the last tool call", () => {
    const sink = createBufferSink();
    sink.sendToken("first reasoning");
    sink.sendToolStatus("sk:test", "tool_a", "call_1", "running");
    sink.sendToolStatus("sk:test", "tool_a", "call_1", "success");
    sink.sendToken("second reasoning");
    sink.sendToolStatus("sk:test", "tool_b", "call_2", "running");
    sink.sendToolStatus("sk:test", "tool_b", "call_2", "success");
    sink.sendToken("final reply");
    expect(sink.getResult().text).toBe("final reply");
  });

  it("preserves text across non-running tool status events", () => {
    const sink = createBufferSink();
    sink.sendToken("partial answer ");
    sink.sendToolStatus("sk:test", "tool_a", "call_1", "success");
    sink.sendToken("rest of answer");
    // status="success" arrives after the tool already started; only
    // the matching status="running" should have triggered the drop,
    // and that's not in this sequence.
    expect(sink.getResult().text).toBe("partial answer rest of answer");
  });

  it("collects tool events in order", () => {
    const sink = createBufferSink();
    sink.sendToolStatus("sk:test", "tool_a", "call_1", "running");
    sink.sendToolStatus("sk:test", "tool_a", "call_1", "success");
    const events = sink.getResult().toolEvents;
    expect(events).toHaveLength(2);
    expect(events[0]?.status).toBe("running");
    expect(events[1]?.status).toBe("success");
  });

  it("collects errors", () => {
    const sink = createBufferSink();
    sink.sendError("E_X", "boom");
    expect(sink.getResult().errors).toEqual([{ code: "E_X", message: "boom" }]);
  });

  it("reset clears all accumulated state", () => {
    const sink = createBufferSink();
    sink.sendToken("hello");
    sink.sendToolStatus("sk:test", "t", "c", "success");
    sink.sendError("E", "msg");
    sink.reset();
    const r = sink.getResult();
    expect(r.text).toBe("");
    expect(r.toolEvents).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.messageId).toBeNull();
  });

  it("isOpen returns true (buffer always accepts data)", () => {
    expect(createBufferSink().isOpen()).toBe(true);
  });
});
