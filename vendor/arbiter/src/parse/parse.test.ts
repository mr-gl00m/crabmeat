import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "./index.js";
import { applyRot13 } from "../normalize/encodings.js";
import { resetEnv } from "../env.js";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbiter-parse-"));
}

describe("parseRequest — file_write positive", () => {
  it("parses 'write me a story to story.txt' to a file_write intent", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "write me a story to story.txt",
      workspace,
    });
    expect(r).not.toBeNull();
    expect(r?.intent.action).toBe("file_write");
    expect(r?.intent.effectClass).toBe("write");
    const params = r?.intent.params as Record<string, unknown>;
    expect(params["filename"]).toBe("story.txt");
    expect(params["contentNeeded"]).toBe("a story");
    expect(typeof params["absolutePath"]).toBe("string");
    expect(typeof r?.intent.id).toBe("string");
    expect(typeof r?.intent.parsedAt).toBe("number");
  });

  it("parses 'save the report to notes/report.md'", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "save the report to notes/report.md",
      workspace,
    });
    expect(r?.intent.action).toBe("file_write");
    const params = r?.intent.params as Record<string, unknown>;
    expect(params["filename"]).toBe("notes/report.md");
  });
});

describe("parseRequest — adversarial negatives", () => {
  it("rejects path traversal in extracted filename", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "write me a story to ../../etc/passwd",
      workspace,
    });
    expect(r).toBeNull();
  });

  it("does NOT file_write on topic-vs-destination ambiguity", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "write a story about story.txt",
      workspace,
    });
    expect(r).toBeNull();
  });

  it("escalates compound intent to null", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "read story.txt and then write me a poem to poem.txt",
      workspace,
    });
    expect(r).toBeNull();
  });

  it("escalates non-English file_write to null (out of scope for v0.1.0)", async () => {
    const workspace = await ws();
    expect(
      parseRequest({
        request: "escribe una historia en story.txt",
        workspace,
      }),
    ).toBeNull();
    expect(
      parseRequest({ request: "écris une histoire dans story.txt", workspace }),
    ).toBeNull();
  });

  it("ROT13 path-traversal: decoded reaches parser as plaintext, gets rejected, decodedFrom flagged", async () => {
    const workspace = await ws();
    const original = "write me a story to ../../etc/passwd";
    const encoded = applyRot13(original);
    const r = parseRequest({ request: encoded, workspace });
    expect(r).toBeNull();
  });

  it("ROT13 of a benign file_write decodes and parses cleanly with decodedFrom set", async () => {
    const workspace = await ws();
    const original = "write me a story to story.txt";
    const encoded = applyRot13(original);
    const r = parseRequest({ request: encoded, workspace });
    expect(r?.intent.action).toBe("file_write");
    expect(r?.decodedFrom).toContain("rot13");
    expect(r?.intent.decodedFrom).toContain("rot13");
  });

  it("rejects absolute system path even when wrapped in normal verbiage", async () => {
    const workspace = await ws();
    expect(
      parseRequest({
        request: "save this to /etc/passwd please",
        workspace,
      }),
    ).toBeNull();
  });
});

describe("parseRequest — file_read", () => {
  it("parses 'read notes/draft.md' to a file_read intent", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "read notes/draft.md",
      workspace,
    });
    expect(r?.intent.action).toBe("file_read");
    expect(r?.intent.effectClass).toBe("read");
  });

  it("rejects file_read with traversal", async () => {
    const workspace = await ws();
    expect(
      parseRequest({ request: "read ../../etc/passwd", workspace }),
    ).toBeNull();
  });
});

describe("parseRequest — web_search routing disabled", () => {
  // Web/news search routing is intentionally disabled in parse/index.ts
  // until execWebSearch is more than a query-echo stub. These tests pin
  // that behavior so a future re-enable is a deliberate choice rather
  // than an accidental regression.

  it("returns null for 'search for X' so the gateway falls through to inference", async () => {
    const workspace = await ws();
    const prior = process.env["ARBITER_SEARCH_ALLOWLIST"];
    delete process.env["ARBITER_SEARCH_ALLOWLIST"];
    resetEnv();
    try {
      const r = parseRequest({
        request: "search for capybara facts",
        workspace,
      });
      expect(r).toBeNull();
    } finally {
      if (prior !== undefined) process.env["ARBITER_SEARCH_ALLOWLIST"] = prior;
      resetEnv();
    }
  });

  it("ignores ARBITER_SEARCH_ALLOWLIST while routing is disabled", async () => {
    const workspace = await ws();
    const prior = process.env["ARBITER_SEARCH_ALLOWLIST"];
    process.env["ARBITER_SEARCH_ALLOWLIST"] = "duckduckgo.com,localhost";
    resetEnv();
    try {
      const r = parseRequest({
        request: "search for capybara facts",
        workspace,
      });
      expect(r).toBeNull();
    } finally {
      if (prior === undefined) delete process.env["ARBITER_SEARCH_ALLOWLIST"];
      else process.env["ARBITER_SEARCH_ALLOWLIST"] = prior;
      resetEnv();
    }
  });

  it("returns null for 'what's the latest on X' (news-search routing also disabled)", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "what's the latest on Overwatch",
      workspace,
    });
    expect(r).toBeNull();
  });

  it("returns null for path-traversal-shaped search queries", async () => {
    const workspace = await ws();
    const r = parseRequest({
      request: "search for ../../etc/passwd",
      workspace,
    });
    expect(r).toBeNull();
  });
});
