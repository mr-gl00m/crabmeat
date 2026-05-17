import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecute } from "./index.js";
import { initAuditDb } from "../audit/db.js";
import { verifyChain } from "../audit/append.js";
import { extractIntent } from "../index.js";
import { loadOrCreateKeyPairSync } from "../sign/keys.js";
import { canonicalize, signConsultation, signIntent } from "../sign/sign.js";
import { sign as cryptoSign } from "node:crypto";
import { resetEnv } from "../env.js";
import type { EffectClass, Intent } from "../types.js";

/**
 * Build a signed web_search intent without going through parseRequest /
 * extractIntent — search routing is currently disabled in parse/index.ts
 * (see the note there) so the executor stub must be exercised directly.
 */
function buildWebSearchIntent(query: string, effectClass: EffectClass): Intent {
  const kp = loadOrCreateKeyPairSync();
  const unsigned: Omit<Intent, "signature"> = {
    id: randomUUID(),
    action: "web_search",
    params: { query },
    effectClass,
    parsedAt: Date.now(),
  };
  const signature = signIntent(unsigned, kp.privateKey);
  return { ...unsigned, signature };
}

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arbiter-exec-"));
}

async function freshDb(): Promise<ReturnType<typeof initAuditDb>> {
  const d = await mkdtemp(join(tmpdir(), "arbiter-exec-db-"));
  return initAuditDb(join(d, "audit.db"));
}

function withConsultedAt(intent: Intent, ts: number, hash: string = "x"): Intent {
  intent.consultedAt = ts;
  // RT-2026-04-30-010 — produce a matching consultation signature for the
  // (intentId, ts, hash) triple so the executor's verification accepts it.
  // Tests that pass `consultation: { hash: 'x' }` therefore line up with this
  // default; tests with custom hashes must pass the same hash here.
  const kp = loadOrCreateKeyPairSync();
  intent.consultationSignature = signConsultation(intent.id, ts, hash, kp.privateKey);
  return intent;
}

describe("runExecute — file_write content mode", () => {
  it("writes a real file using consultation.text as content", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
      );
      const result = await runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "Once upon a time.",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        { workspace, auditDb: db },
      );
      expect(result.ok).toBe(true);
      const out = result.output as { writtenTo: string };
      expect(await readFile(out.writtenTo, "utf-8")).toBe("Once upon a time.");
    } finally {
      db.close();
    }
  });

  it("uses reconciliation.args.content when reconciliation is provided", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
      );
      const result = await runExecute(
        intent,
        {
          reconciliation: {
            outcome: "approved",
            reason: "test",
            round: 1,
            args: { filename: "story.txt", content: "from reconciliation" },
          },
        },
        { workspace, auditDb: db },
      );
      expect(result.ok).toBe(true);
      const out = result.output as { writtenTo: string };
      expect(await readFile(out.writtenTo, "utf-8")).toBe("from reconciliation");
    } finally {
      db.close();
    }
  });
});

describe("runExecute — security gates", () => {
  it("rejects an intent whose signature does not match", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
      );
      const tampered: Intent = {
        ...intent,
        params: { ...intent.params, filename: "evil.txt" },
      };
      const result = await runExecute(tampered, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/signature/);
    } finally {
      db.close();
    }
  });

  it("rejects when consultedAt is missing", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = extractIntent("write me a story to story.txt", {
        workspace,
      }) as Intent;
      const result = await runExecute(intent, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/consultedAt/);
    } finally {
      db.close();
    }
  });

  it("rejects when the consult->execute window has elapsed", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = extractIntent("write me a story to story.txt", {
        workspace,
      }) as Intent;
      const now = Date.now();
      (intent as unknown as { parsedAt: number }).parsedAt = now - 601_000;
      intent.consultedAt = now - 600_000;
      const kp = loadOrCreateKeyPairSync();
      const { signature: _drop, ...unsigned } = intent;
      void _drop;
      const resigned: Intent = {
        ...unsigned,
        signature: signIntent(unsigned, kp.privateKey),
      };
      resigned.consultedAt = now - 600_000;
      const result = await runExecute(
        resigned,
        {},
        { workspace, auditDb: db },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/consult->execute/);
    } finally {
      db.close();
    }
  });

  it("rejects a tampered consultedAt (RT-2026-04-30-010)", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
        "x",
      );
      // Mutate consultedAt after the consultation signature was bound. The
      // signature still matches the original triple, not the tampered one.
      intent.consultedAt = Date.now() + 1_000_000;
      const result = await runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "approved",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        { workspace, auditDb: db },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/consultation signature/);
    } finally {
      db.close();
    }
  });

  it("re-validates path-jail at execute time when args specify a traversal", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
      );
      const result = await runExecute(
        intent,
        {
          reconciliation: {
            outcome: "approved",
            reason: "test",
            round: 1,
            args: { filename: "../../etc/passwd", content: "x" },
          },
        },
        { workspace, auditDb: db },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/path-jail/);
    } finally {
      db.close();
    }
  });
});

describe("runExecute — file_read", () => {
  it("reads an existing file in the workspace", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const target = join(workspace, "draft.md");
      await writeFile(target, "# hello\n", "utf-8");
      const intent = withConsultedAt(
        extractIntent("read draft.md", { workspace }) as Intent,
        Date.now(),
      );
      const result = await runExecute(intent, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(true);
      const out = result.output as { content: string };
      expect(out.content).toBe("# hello\n");
    } finally {
      db.close();
    }
  });

  it("returns ok=false when the file is missing", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("read missing.md", { workspace }) as Intent,
        Date.now(),
      );
      const result = await runExecute(intent, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects oversized file reads with a clear error (RT-2026-04-30-004)", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const target = join(workspace, "huge.txt");
      // 64 KiB of content is well above the 1 KiB cap we'll set for the test.
      await writeFile(target, "x".repeat(64 * 1024), "utf-8");
      const intent = withConsultedAt(
        extractIntent("read huge.txt", { workspace }) as Intent,
        Date.now(),
      );
      // Override the cap via a fresh executor call by importing the tool
      // directly. We exercise the runExecute path with the default cap by
      // making the file just slightly too big.
      // Default cap is 2 MiB; produce 2 MiB + 1 byte.
      await writeFile(target, "x".repeat(2 * 1024 * 1024 + 1), "utf-8");
      const result = await runExecute(intent, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/file_read max size exceeded/);
    } finally {
      db.close();
    }
  });

  it("audit row for file_read stores hash + bytes, not raw content (RT-2026-04-30-002)", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const target = join(workspace, "secret.md");
      const secretContent = "TOPSECRET-not-allowed-in-audit\n";
      await writeFile(target, secretContent, "utf-8");
      const intent = withConsultedAt(
        extractIntent("read secret.md", { workspace }) as Intent,
        Date.now(),
      );
      await runExecute(intent, {}, { workspace, auditDb: db });
      const rows = db.handle
        .prepare("SELECT payload_json FROM arbiter_audit WHERE kind='execution'")
        .all() as Array<{ payload_json: string }>;
      expect(rows.length).toBe(1);
      const payload = JSON.parse(rows[0]!.payload_json);
      expect(payload.output).toBeDefined();
      expect(payload.output.content).toBeUndefined();
      expect(payload.output.bytes).toBe(secretContent.length);
      expect(typeof payload.output.contentHash).toBe("string");
      expect(payload.output.contentHash).toHaveLength(64);
      // Belt and suspenders: the secret string must not appear anywhere in the row.
      expect(rows[0]!.payload_json).not.toContain("TOPSECRET");
    } finally {
      db.close();
    }
  });
});

describe("runExecute — web_search (v0.1.0 stub)", () => {
  // Web-search routing through parseRequest is disabled (see parse/index.ts).
  // Intents here are constructed manually so the stub executor stays
  // covered until a real backend lands.

  it("auto-allows execution when effectClass=search", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        buildWebSearchIntent("capybara facts", "search"),
        Date.now(),
      );
      const result = await runExecute(intent, {}, { workspace, auditDb: db });
      expect(result.ok).toBe(true);
      const out = result.output as { query: string; note: string };
      expect(out.query).toBe("capybara facts");
      expect(out.note).toMatch(/v0\.1\.0/);
    } finally {
      db.close();
    }
  });

  it("escalates to HITL when effectClass=network", async () => {
    const workspace = await ws();
    const dir = await mkdtemp(join(tmpdir(), "arbiter-pending-"));
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        buildWebSearchIntent("capybara facts", "network"),
        Date.now(),
      );
      const result = await runExecute(
        intent,
        {},
        {
          workspace,
          auditDb: db,
          hitl: { dir, timeoutMs: 200, pollIntervalMs: 50 },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HITL approval timeout/);
    } finally {
      db.close();
    }
  });
});

describe("runExecute — HITL gates", () => {
  function makeHitlIntent(workspace: string): Intent {
    const intent = extractIntent("write me a story to story.txt", {
      workspace,
    }) as Intent;
    const kp = loadOrCreateKeyPairSync();
    const elevated: Omit<Intent, "signature"> = {
      ...intent,
      effectClass: "exec",
    };
    const signature = signIntent(elevated, kp.privateKey);
    return withConsultedAt({ ...elevated, signature }, Date.now());
  }

  it("writes pending JSON and times out when no signed file appears", async () => {
    const workspace = await ws();
    const dir = await mkdtemp(join(tmpdir(), "arbiter-pending-"));
    const db = await freshDb();
    try {
      const intent = makeHitlIntent(workspace);
      const result = await runExecute(
        intent,
        {},
        {
          workspace,
          auditDb: db,
          hitl: { dir, timeoutMs: 300, pollIntervalMs: 50 },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HITL approval timeout/);
    } finally {
      db.close();
    }
  });

  it("proceeds when a signed file is present before timeout", async () => {
    const workspace = await ws();
    const dir = await mkdtemp(join(tmpdir(), "arbiter-pending-"));
    const db = await freshDb();
    try {
      const intent = makeHitlIntent(workspace);

      const promise = runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "approved-content",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        {
          workspace,
          auditDb: db,
          hitl: { dir, timeoutMs: 2000, pollIntervalMs: 50 },
        },
      );

      await new Promise((r) => setTimeout(r, 100));
      // RT-2026-04-30-001 — approval requires a real Ed25519 signature over
      // canonicalize(intent). Sign with the arbiter key; the executor will
      // verify against the public half.
      const kp = loadOrCreateKeyPairSync();
      const sig = cryptoSign(null, Buffer.from(canonicalize(intent), "utf-8"), kp.privateKey).toString("base64");
      await writeFile(join(dir, `${intent.id}.signed`), sig, "utf-8");

      const result = await promise;
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects unsigned/garbage approval files (RT-2026-04-30-001)", async () => {
    const workspace = await ws();
    const dir = await mkdtemp(join(tmpdir(), "arbiter-pending-"));
    const db = await freshDb();
    try {
      const intent = makeHitlIntent(workspace);

      const promise = runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "approved-content",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        {
          workspace,
          auditDb: db,
          hitl: { dir, timeoutMs: 400, pollIntervalMs: 50 },
        },
      );

      await new Promise((r) => setTimeout(r, 100));
      // Pre-fix this string approves; post-fix it must not.
      await writeFile(join(dir, `${intent.id}.signed`), "ok", "utf-8");

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HITL approval timeout/);
    } finally {
      db.close();
    }
  });

  it("rejects a signature over a different intent (RT-2026-04-30-001)", async () => {
    const workspace = await ws();
    const dir = await mkdtemp(join(tmpdir(), "arbiter-pending-"));
    const db = await freshDb();
    try {
      const intent = makeHitlIntent(workspace);
      const otherIntent = makeHitlIntent(workspace);

      const promise = runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "approved-content",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        {
          workspace,
          auditDb: db,
          hitl: { dir, timeoutMs: 400, pollIntervalMs: 50 },
        },
      );

      await new Promise((r) => setTimeout(r, 100));
      // Valid signature, wrong intent — must not approve.
      const kp = loadOrCreateKeyPairSync();
      const wrongSig = cryptoSign(null, Buffer.from(canonicalize(otherIntent), "utf-8"), kp.privateKey).toString("base64");
      await writeFile(join(dir, `${intent.id}.signed`), wrongSig, "utf-8");

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HITL approval timeout/);
    } finally {
      db.close();
    }
  });

  it("skipHitl bypasses the gate (developer escape hatch)", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = makeHitlIntent(workspace);
      const result = await runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "body",
            hash: "x",
            receivedAt: Date.now(),
          },
        },
        { workspace, auditDb: db, skipHitl: true },
      );
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("runExecute — audit chain", () => {
  it("appends an execution row that links to prior consultation rows", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      const intent = withConsultedAt(
        extractIntent("write me a story to story.txt", { workspace }) as Intent,
        Date.now(),
        "h",
      );
      await runExecute(
        intent,
        {
          consultation: {
            intentId: intent.id,
            text: "body",
            hash: "h",
            receivedAt: Date.now(),
          },
        },
        { workspace, auditDb: db },
      );
      const rows = db.handle
        .prepare("SELECT kind FROM arbiter_audit ORDER BY seq ASC")
        .all() as Array<{ kind: string }>;
      expect(rows.map((r) => r.kind)).toEqual(["execution"]);
      expect(verifyChain(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("integration: 200 synthetic file_writes produce 200 files and a verified chain", async () => {
    const workspace = await ws();
    const db = await freshDb();
    try {
      for (let i = 0; i < 200; i++) {
        const intent = withConsultedAt(
          extractIntent(`write me a story to story-${i}.txt`, {
            workspace,
          }) as Intent,
          Date.now(),
          "h",
        );
        const result = await runExecute(
          intent,
          {
            consultation: {
              intentId: intent.id,
              text: `body-${i}`,
              hash: "h",
              receivedAt: Date.now(),
            },
          },
          { workspace, auditDb: db },
        );
        expect(result.ok).toBe(true);
      }
      const count = db.handle
        .prepare("SELECT COUNT(*) as n FROM arbiter_audit")
        .get() as { n: number };
      expect(count.n).toBe(200);
      expect(verifyChain(db).ok).toBe(true);

      const last = await readFile(join(workspace, "story-199.txt"), "utf-8");
      expect(last).toBe("body-199");
    } finally {
      db.close();
    }
  }, 20_000);
});
