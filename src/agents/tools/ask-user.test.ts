import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import {
  registerAskUserSender,
  receiveAnswer,
  _resetAskUserBroker,
  type UserQuestionPayload,
} from "./ask-user-broker.js";
import type { ToolExecutionContext } from "./types.js";

beforeAll(() => {
  registerBuiltinTools();
});

beforeEach(() => {
  _resetAskUserBroker();
});

const ctx: ToolExecutionContext = { sessionKey: "s1", agentId: "default" };

describe("ask_user tool handler", () => {
  it("is registered", () => {
    expect(hasToolHandler("ask_user")).toBe(true);
  });

  it("errors without a session context", async () => {
    const handler = getToolHandler("ask_user");
    const res = await handler({ question: "hi?" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("active user session");
  });

  it("errors when no sender is registered (no active client)", async () => {
    const handler = getToolHandler("ask_user");
    const res = await handler({ question: "hi?" }, undefined, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no active client");
  });

  it("errors on empty question", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler({ question: "   " }, undefined, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'question' is required");
  });

  it("errors when question exceeds max length", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler(
      { question: "x".repeat(2001) },
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too long");
  });

  it("errors on non-array options", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler(
      { question: "q?", options: "not an array" },
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("must be an array");
  });

  it("errors when too many options", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler(
      { question: "q?", options: Array(9).fill("x") },
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too many options");
  });

  it("errors on empty string option", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler(
      { question: "q?", options: ["a", ""] },
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("non-empty string");
  });

  it("delivers question via the registered sender and returns the answer", async () => {
    const sent: UserQuestionPayload[] = [];
    registerAskUserSender("s1", (p) => sent.push(p));
    const handler = getToolHandler("ask_user");

    // Kick off the handler (doesn't await yet)
    const pending = handler(
      { question: "Which file?", options: ["a.ts", "b.ts"] },
      undefined,
      ctx,
    );

    // Sender was called synchronously
    expect(sent).toHaveLength(1);
    expect(sent[0]!.question).toBe("Which file?");
    expect(sent[0]!.options).toEqual(["a.ts", "b.ts"]);

    // Respond as the client
    receiveAnswer(sent[0]!.questionId, "s1", { answer: "a.ts", optionIndex: 0 });

    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("option 0");
    expect(res.content).toContain("a.ts");
  });

  it("returns freeform answer when no optionIndex given", async () => {
    const sent: UserQuestionPayload[] = [];
    registerAskUserSender("s1", (p) => sent.push(p));
    const handler = getToolHandler("ask_user");

    const pending = handler({ question: "Your name?" }, undefined, ctx);
    receiveAnswer(sent[0]!.questionId, "s1", { answer: "Sam" });
    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("User answered: Sam");
  });

  it("returns a timeout error when the user doesn't answer", async () => {
    registerAskUserSender("s1", () => {});
    const handler = getToolHandler("ask_user");
    const res = await handler(
      { question: "slow?", timeout_ms: 1000 },
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timed out");
  });
});
