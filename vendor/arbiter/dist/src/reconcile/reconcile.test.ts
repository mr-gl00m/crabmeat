import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileImpl } from "./index.js";
import { negotiate } from "./negotiate.js";
import { parseProposal } from "./proposal.js";
import { permissionCone, DEFAULT_TOOL_CATALOG } from "./cone.js";
import { initAuditDb } from "../audit/db.js";
import type { Consultation, Intent, ProviderFn } from "../types.js";

function fileWriteIntent(filename = "story.txt"): Intent {
  return {
    id: "i1",
    action: "file_write",
    params: { filename, contentNeeded: "a story" },
    effectClass: "write",
    parsedAt: Date.now(),
  };
}

function consult(text: string): Consultation {
  return { intentId: "i1", text, hash: "x", receivedAt: Date.now() };
}

function fixedProvider(replies: readonly string[]): ProviderFn {
  let i = 0;
  return async function* () {
    const reply = replies[i++ % replies.length] ?? "";
    yield { delta: reply };
  };
}

async function freshDb(): Promise<ReturnType<typeof initAuditDb>> {
  const dir = await mkdtemp(join(tmpdir(), "arbiter-rec-"));
  return initAuditDb(join(dir, "audit.db"));
}

describe("permissionCone", () => {
  it("limits cone to tools matching the intent's effectClass", () => {
    expect(
      permissionCone(fileWriteIntent()).map((t) => t.name),
    ).toEqual(["file_write"]);
    expect(
      permissionCone({
        ...fileWriteIntent(),
        action: "file_read",
        effectClass: "read",
      }).map((t) => t.name),
    ).toEqual(["file_read"]);
    expect(
      permissionCone({
        ...fileWriteIntent(),
        action: "web_search",
        effectClass: "search",
      }).map((t) => t.name),
    ).toEqual(["web_search"]);
  });
});

describe("parseProposal", () => {
  it("parses strict JSON", () => {
    const p = parseProposal('{"tool":"file_write","args":{"content":"hi"}}');
    expect(p?.tool).toBe("file_write");
    expect(p?.args["content"]).toBe("hi");
  });

  it("parses ```json fenced JSON", () => {
    const p = parseProposal(
      '```json\n{"tool":"file_write","args":{"content":"x"}}\n```',
    );
    expect(p?.tool).toBe("file_write");
  });

  it("parses an object embedded in surrounding chatter", () => {
    const p = parseProposal(
      'Here is the call: {"tool":"file_write","args":{"content":"x"}} done.',
    );
    expect(p?.tool).toBe("file_write");
  });

  it("returns null for non-JSON", () => {
    expect(parseProposal("hello, world")).toBeNull();
  });

  it("returns null for JSON without a tool field", () => {
    expect(parseProposal('{"args":{"x":1}}')).toBeNull();
  });

  it("returns null for null / array / primitives", () => {
    expect(parseProposal("null")).toBeNull();
    expect(parseProposal("[1,2,3]")).toBeNull();
    expect(parseProposal('"just a string"')).toBeNull();
  });
});

describe("reconcileImpl — outcome paths", () => {
  it("approves a matching proposal", () => {
    const intent = fileWriteIntent();
    const proposal = consult(
      JSON.stringify({
        tool: "file_write",
        args: { filename: "story.txt", content: "Once upon a time." },
      }),
    );
    const r = reconcileImpl(intent, proposal);
    expect(r.outcome).toBe("approved");
    expect(r.args).toEqual({ filename: "story.txt", content: "Once upon a time." });
  });

  it("rejects an out-of-cone tool with structured feedback", () => {
    const intent = fileWriteIntent();
    const proposal = consult(
      JSON.stringify({ tool: "send_email", args: { to: "x", body: "y" } }),
    );
    const r = reconcileImpl(intent, proposal);
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toMatch(/permission cone/);
    expect(r.reason).toMatch(/file_write/);
  });

  it("refines a partial-match where filename diverged from intent", () => {
    const intent = fileWriteIntent("story.txt");
    const proposal = consult(
      JSON.stringify({
        tool: "file_write",
        args: { filename: "ignored.txt", content: "body" },
      }),
    );
    const r = reconcileImpl(intent, proposal);
    expect(r.outcome).toBe("refined");
    expect(r.args).toEqual({ filename: "story.txt", content: "body" });
    expect(r.reason).toMatch(/overridden by intent/);
  });

  it("rejects when LLM-provided required arg (content) is missing", () => {
    const intent = fileWriteIntent();
    const proposal = consult(
      JSON.stringify({ tool: "file_write", args: { filename: "story.txt" } }),
    );
    const r = reconcileImpl(intent, proposal);
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toMatch(/missing required arg "content"/);
  });

  it("rejects unparseable consultation text", () => {
    const r = reconcileImpl(fileWriteIntent(), consult("¯\\_(ツ)_/¯"));
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toMatch(/not parseable/);
  });

  it("carries the round number through unchanged", () => {
    const r = reconcileImpl(fileWriteIntent(), consult("garbage"), {
      round: 2,
    });
    expect(r.round).toBe(2);
  });
});

describe("negotiate — round budget and adversarial provider", () => {
  it("approves on round 1 when LLM is correct first time", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        JSON.stringify({
          tool: "file_write",
          args: { filename: "story.txt", content: "the body" },
        }),
      ]);
      const result = await negotiate(intent, provider, { auditDb: db });
      expect(result.outcome).toBe("approved");
      expect(result.round).toBe(1);
    } finally {
      db.close();
    }
  });

  it("approves on round 2 after rejection feedback", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        JSON.stringify({ tool: "file_write", args: { filename: "story.txt" } }),
        JSON.stringify({
          tool: "file_write",
          args: { filename: "story.txt", content: "the body" },
        }),
      ]);
      const result = await negotiate(intent, provider, { auditDb: db });
      expect(result.outcome).toBe("approved");
      expect(result.round).toBe(2);
    } finally {
      db.close();
    }
  });

  it("exhausts at round 2 when provider stays wrong", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        JSON.stringify({ tool: "hallucinated_tool", args: {} }),
        JSON.stringify({ tool: "hallucinated_tool", args: {} }),
      ]);
      const result = await negotiate(intent, provider, { auditDb: db });
      expect(result.outcome).toBe("exhausted");
      expect(result.round).toBe(2);
    } finally {
      db.close();
    }
  });

  it("adversarial provider (malformed / null / hallucinated) exhausts in two rounds without infinite loop", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        "not even close to JSON",
        "null",
      ]);
      const start = Date.now();
      const result = await negotiate(intent, provider, { auditDb: db });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(result.outcome).toBe("exhausted");
    } finally {
      db.close();
    }
  });

  it("negotiate respects custom maxRounds", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        JSON.stringify({ tool: "wrong", args: {} }),
      ]);
      const result = await negotiate(intent, provider, {
        auditDb: db,
        maxRounds: 1,
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.round).toBe(1);
    } finally {
      db.close();
    }
  });

  it("logs reconciliation rows alongside consultation rows in the audit chain", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const provider = fixedProvider([
        JSON.stringify({ tool: "file_write", args: { content: "body" } }),
      ]);
      await negotiate(intent, provider, { auditDb: db });
      const kinds = (
        db.handle
          .prepare(
            "SELECT kind FROM arbiter_audit ORDER BY seq ASC",
          )
          .all() as Array<{ kind: string }>
      ).map((r) => r.kind);
      expect(kinds).toEqual(["consultation", "reconciliation"]);
    } finally {
      db.close();
    }
  });

  it("rejection feedback flows into round 2's system prompt", async () => {
    const db = await freshDb();
    try {
      const intent = fileWriteIntent();
      const seenSystems: string[] = [];
      const provider: ProviderFn = async function* (messages) {
        seenSystems.push(messages[0]!.content);
        yield { delta: JSON.stringify({ tool: "wrong", args: {} }) };
      };
      await negotiate(intent, provider, { auditDb: db });
      expect(seenSystems).toHaveLength(2);
      expect(seenSystems[0]!).not.toMatch(/Previous round was rejected/);
      expect(seenSystems[1]!).toMatch(/Previous round was rejected/);
    } finally {
      db.close();
    }
  });
});

describe("DEFAULT_TOOL_CATALOG", () => {
  it("covers the three intents one-to-one", () => {
    const names = DEFAULT_TOOL_CATALOG.map((t) => t.name).sort();
    expect(names).toEqual(["file_read", "file_write", "web_search"]);
  });
});
