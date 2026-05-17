import { describe, it, expect, beforeEach } from "vitest";
import {
  askQuestion,
  receiveAnswer,
  registerAskUserSender,
  unregisterAskUserSender,
  cancelAllForSession,
  pendingCount,
  _resetAskUserBroker,
  type UserQuestionPayload,
} from "./ask-user-broker.js";

beforeEach(() => {
  _resetAskUserBroker();
});

function captureSender(buf: UserQuestionPayload[]): (p: UserQuestionPayload) => void {
  return (p) => buf.push(p);
}

describe("ask-user-broker", () => {
  it("rejects when no sender is registered for the session", async () => {
    await expect(
      askQuestion({ sessionKey: "s1", question: "hi" }),
    ).rejects.toThrow(/no active client/);
  });

  it("delivers the question to the registered sender", async () => {
    const sent: UserQuestionPayload[] = [];
    registerAskUserSender("s1", captureSender(sent));

    const pending = askQuestion({
      sessionKey: "s1",
      question: "pick one",
      options: ["a", "b"],
    });

    // Sender was invoked synchronously inside askQuestion
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question).toBe("pick one");
    expect(sent[0]!.options).toEqual(["a", "b"]);
    expect(sent[0]!.allowFreeform).toBe(true);
    expect(sent[0]!.sessionId).toBe("s1");

    // Answer it so the pending promise resolves
    const questionId = sent[0]!.questionId;
    const delivered = receiveAnswer(questionId, "s1", { answer: "a", optionIndex: 0 });
    expect(delivered).toBe(true);

    const reply = await pending;
    expect(reply.answer).toBe("a");
    expect(reply.optionIndex).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it("times out when no answer arrives", async () => {
    registerAskUserSender("s1", () => {});
    const start = Date.now();
    await expect(
      askQuestion({ sessionKey: "s1", question: "q", timeoutMs: 1000 }),
    ).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    // 1s min clamp — allow some slack
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(pendingCount()).toBe(0);
  });

  it("clamps timeoutMs to [MIN, MAX]", async () => {
    registerAskUserSender("s1", () => {});
    // 1ms would be silly — clamped to 1000ms MIN
    const start = Date.now();
    await expect(
      askQuestion({ sessionKey: "s1", question: "q", timeoutMs: 1 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("cancels pending questions when session is unregistered", async () => {
    registerAskUserSender("s1", () => {});
    const pending = askQuestion({ sessionKey: "s1", question: "q", timeoutMs: 60_000 });
    unregisterAskUserSender("s1");
    await expect(pending).rejects.toThrow(/client disconnected/);
    expect(pendingCount()).toBe(0);
  });

  it("cancels pending when a new sender replaces the old one", async () => {
    registerAskUserSender("s1", () => {});
    const pending = askQuestion({ sessionKey: "s1", question: "q", timeoutMs: 60_000 });
    // New client takes over
    registerAskUserSender("s1", () => {});
    await expect(pending).rejects.toThrow(/sender replaced/);
  });

  it("cancelAllForSession only drops questions for that session", async () => {
    const sentA: UserQuestionPayload[] = [];
    const sentB: UserQuestionPayload[] = [];
    registerAskUserSender("sA", captureSender(sentA));
    registerAskUserSender("sB", captureSender(sentB));

    const pa = askQuestion({ sessionKey: "sA", question: "A", timeoutMs: 60_000 });
    const pb = askQuestion({ sessionKey: "sB", question: "B", timeoutMs: 60_000 });

    cancelAllForSession("sA", "testing");

    await expect(pa).rejects.toThrow(/testing/);
    expect(pendingCount()).toBe(1);

    // sB is still answerable
    receiveAnswer(sentB[0]!.questionId, "sB", { answer: "ok" });
    await expect(pb).resolves.toMatchObject({ answer: "ok" });
  });

  it("receiveAnswer returns false for unknown questionId", () => {
    expect(receiveAnswer("no-such-id", "s1", { answer: "x" })).toBe(false);
  });

  it("receiveAnswer refuses cross-session answers", async () => {
    const sent: UserQuestionPayload[] = [];
    registerAskUserSender("s1", captureSender(sent));
    const pending = askQuestion({ sessionKey: "s1", question: "q", timeoutMs: 60_000 });

    // Attacker tries to answer s1's question from s2
    const delivered = receiveAnswer(sent[0]!.questionId, "s2", { answer: "evil" });
    expect(delivered).toBe(false);

    // Real answer still works
    receiveAnswer(sent[0]!.questionId, "s1", { answer: "real" });
    await expect(pending).resolves.toMatchObject({ answer: "real" });
  });

  it("handles sender throwing synchronously", async () => {
    registerAskUserSender("s1", () => {
      throw new Error("ws dead");
    });
    await expect(
      askQuestion({ sessionKey: "s1", question: "q" }),
    ).rejects.toThrow(/send failed.*ws dead/);
    expect(pendingCount()).toBe(0);
  });

  it("multiple concurrent questions on same session each resolve independently", async () => {
    const sent: UserQuestionPayload[] = [];
    registerAskUserSender("s1", captureSender(sent));

    const p1 = askQuestion({ sessionKey: "s1", question: "q1", timeoutMs: 60_000 });
    const p2 = askQuestion({ sessionKey: "s1", question: "q2", timeoutMs: 60_000 });
    const p3 = askQuestion({ sessionKey: "s1", question: "q3", timeoutMs: 60_000 });

    expect(sent).toHaveLength(3);
    expect(pendingCount()).toBe(3);

    // Answer in reverse order
    receiveAnswer(sent[2]!.questionId, "s1", { answer: "third" });
    receiveAnswer(sent[0]!.questionId, "s1", { answer: "first" });
    receiveAnswer(sent[1]!.questionId, "s1", { answer: "second" });

    await expect(p1).resolves.toMatchObject({ answer: "first" });
    await expect(p2).resolves.toMatchObject({ answer: "second" });
    await expect(p3).resolves.toMatchObject({ answer: "third" });
  });
});
