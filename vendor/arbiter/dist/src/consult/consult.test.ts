import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConsult } from "./index.js";
import { initAuditDb } from "../audit/db.js";
import { verifyChain } from "../audit/append.js";
import { sha256Hex } from "../audit/hash.js";
import type { Intent, ProviderFn, ProviderMessage } from "../types.js";

function fixture(): Intent {
  return {
    id: "intent-1",
    action: "file_write",
    params: { filename: "story.txt", contentNeeded: "a short story" },
    effectClass: "write",
    parsedAt: Date.now() - 1000,
  };
}

function recordingProvider(reply: string): {
  fn: ProviderFn;
  seen: ProviderMessage[][];
} {
  const seen: ProviderMessage[][] = [];
  const fn: ProviderFn = async function* (messages) {
    seen.push([...messages]);
    yield { delta: reply };
  };
  return { fn, seen };
}

async function freshDb(): Promise<ReturnType<typeof initAuditDb>> {
  const dir = await mkdtemp(join(tmpdir(), "arbiter-consult-"));
  return initAuditDb(join(dir, "audit.db"));
}

describe("runConsult", () => {
  it("calls the provider with system + user messages and returns the streamed text", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      const { fn, seen } = recordingProvider("Once upon a time there was a cat.");
      const result = await runConsult(intent, fn, { auditDb: db });

      expect(result.text).toBe("Once upon a time there was a cat.");
      expect(seen).toHaveLength(1);
      const messages = seen[0]!;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("system");
      expect(messages[0]!.content).toMatch(/Output ONLY/);
      expect(messages[1]!.role).toBe("user");
      expect(messages[1]!.content).toContain("<INTENT>file_write</INTENT>");
    } finally {
      db.close();
    }
  });

  it("hashes the consultation result with sha256 and returns it on the consultation", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      const reply = "deterministic body text";
      const { fn } = recordingProvider(reply);
      const result = await runConsult(intent, fn, { auditDb: db });
      expect(result.hash).toBe(sha256Hex(reply));
    } finally {
      db.close();
    }
  });

  it("sets consultedAt on the intent struct before returning", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      expect(intent.consultedAt).toBeUndefined();
      const { fn } = recordingProvider("body");
      await runConsult(intent, fn, { auditDb: db });
      expect(typeof intent.consultedAt).toBe("number");
      expect(intent.consultedAt).toBeGreaterThan(intent.parsedAt);
    } finally {
      db.close();
    }
  });

  it("appends a chained consultation row to the audit DB", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      const { fn } = recordingProvider("body");
      await runConsult(intent, fn, { auditDb: db });

      const rows = db.handle
        .prepare(
          "SELECT seq, kind, intent_id, payload_json FROM arbiter_audit ORDER BY seq ASC",
        )
        .all() as Array<{
          seq: number;
          kind: string;
          intent_id: string | null;
          payload_json: string;
        }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("consultation");
      expect(rows[0]!.intent_id).toBe(intent.id);
      const payload = JSON.parse(rows[0]!.payload_json);
      expect(payload.hash).toBe(sha256Hex("body"));
      expect(verifyChain(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("respects an opts.systemPrompt override", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      const { fn, seen } = recordingProvider("ok");
      await runConsult(intent, fn, {
        auditDb: db,
        systemPrompt: "you are a custom oracle",
      });
      expect(seen[0]![0]!.content).toBe("you are a custom oracle");
    } finally {
      db.close();
    }
  });

  it("truncates streamed output above maxConsultBytes (RT-2026-04-30-003)", async () => {
    const db = await freshDb();
    try {
      const intent = fixture();
      let chunksProduced = 0;
      const runaway: ProviderFn = async function* () {
        // A misbehaving provider that streams forever. The cap must stop us.
        while (true) {
          chunksProduced++;
          yield { delta: "x".repeat(64) };
          if (chunksProduced > 1000) {
            // Test safety net — if we get this far the cap is broken.
            throw new Error("cap not enforced");
          }
        }
      };
      const result = await runConsult(intent, runaway, {
        auditDb: db,
        maxConsultBytes: 256,
      });
      expect(result.text.length).toBe(256);
      const rows = db.handle
        .prepare("SELECT payload_json FROM arbiter_audit WHERE kind='consultation'")
        .all() as Array<{ payload_json: string }>;
      const payload = JSON.parse(rows[0]!.payload_json);
      expect(payload.truncated).toBe(true);
      expect(payload.maxBytes).toBe(256);
    } finally {
      db.close();
    }
  });
});
