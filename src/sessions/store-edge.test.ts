import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSessionStore, type SessionStore } from "./store.js";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SessionStore — edge cases", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-edge-"));
    store = createSessionStore({
      backend: "json",
      dir,
      maxTranscriptEntries: 200,
      retentionDays: 30,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("handles corrupted JSON on disk gracefully", async () => {
    // Write garbage to a session file (filename is SHA-256 hash of key)
    await store.save(store.create("good-key", "agent-1"));
    const hash = createHash("sha256").update("good-key").digest("hex");
    const filePath = join(dir, `${hash}.json`);
    await writeFile(filePath, "{not valid json!!! broken", "utf-8");

    // Load should throw (not silently return undefined)
    await expect(store.load("good-key")).rejects.toThrow();
  });

  it("sanitizes path traversal characters from session key", async () => {
    const session = store.create("../../../etc/passwd", "agent-1");
    await store.save(session);

    const keys = await store.list();
    // Should NOT create files outside the session directory
    expect(keys.every((k) => !k.includes("/") && !k.includes("\\") && !k.includes(".."))).toBe(true);
  });

  it("handles session key with only special characters", async () => {
    // After sanitization, key becomes empty string
    const session = store.create("!!!@@@###", "agent-1");
    await store.save(session);
    // Should create file named ".json" — verify no crash
    const keys = await store.list();
    expect(keys).toHaveLength(1);
  });

  it("handles concurrent saves to different sessions", async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      store.create(`session-${i}`, "agent-1"),
    );

    // Save all concurrently
    await Promise.all(sessions.map((s) => store.save(s)));

    const keys = await store.list();
    expect(keys).toHaveLength(10);
  });

  it("concurrent saves to SAME session — last write wins (atomic rename prevents corruption)", async () => {
    const s1 = store.create("shared", "agent-1");
    const s2 = store.create("shared", "agent-1");

    s1.transcript.push({
      role: "user",
      content: "message-from-s1",
      timestamp: new Date().toISOString(),
      messageId: "m1",
      trust: { source: "user_input", sigilDetections: [], normalized: false },
    });

    s2.transcript.push({
      role: "user",
      content: "message-from-s2",
      timestamp: new Date().toISOString(),
      messageId: "m2",
      trust: { source: "user_input", sigilDetections: [], normalized: false },
    });

    // Both save concurrently — one will overwrite the other via atomic rename.
    // File will always be valid JSON (no partial writes), though one message is lost.
    await Promise.all([store.save(s1), store.save(s2)]);

    const loaded = await store.load("shared");
    expect(loaded).toBeDefined();
    // Only one message survives — one write won the race
    expect(loaded!.transcript).toHaveLength(1);
    const content = loaded!.transcript[0]!.content;
    expect(["message-from-s1", "message-from-s2"]).toContain(content);

    // Verify no leftover temp files
    const files = await readdir(dir);
    expect(files.every((f) => !f.includes(".tmp."))).toBe(true);
  });

  it("no session key collision — SHA-256 hashing prevents old sanitization bug", async () => {
    // Old regex approach: "user.123" and "user!123" both became "user123"
    // New SHA-256 approach: each key gets a unique hash
    const s1 = store.create("user.123", "agent-1");
    const s2 = store.create("user!123", "agent-2");

    await store.save(s1);
    await store.save(s2);

    // Both sessions should be independently loadable
    const loaded1 = await store.load("user.123");
    const loaded2 = await store.load("user!123");
    expect(loaded1).toBeDefined();
    expect(loaded2).toBeDefined();
    expect(loaded1!.agentId).toBe("agent-1");
    expect(loaded2!.agentId).toBe("agent-2");
  });

  it("handles very long session keys", async () => {
    const longKey = "a".repeat(200);
    const session = store.create(longKey, "agent-1");
    await store.save(session);
    const loaded = await store.load(longKey);
    expect(loaded).toBeDefined();
  });
});
