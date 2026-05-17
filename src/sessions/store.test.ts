import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSessionStore } from "./store.js";
import type { SessionStore } from "./store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SessionStore (JSON backend)", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crabmeat-test-"));
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

  it("creates a new session with correct fields", () => {
    const session = store.create("key-1", "agent-1", "chan-1", "peer-1");
    expect(session.sessionKey).toBe("key-1");
    expect(session.agentId).toBe("agent-1");
    expect(session.channelId).toBe("chan-1");
    expect(session.peerId).toBe("peer-1");
    expect(session.transcript).toEqual([]);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
  });

  it("returns undefined for non-existent session", async () => {
    const session = await store.load("nonexistent");
    expect(session).toBeUndefined();
  });

  it("saves and loads a session", async () => {
    const session = store.create("key-1", "agent-1");
    session.transcript.push({
      role: "user",
      content: "Hello",
      timestamp: new Date().toISOString(),
      messageId: "msg-1",
      trust: { source: "user_input", sigilDetections: [], normalized: false },
    });

    await store.save(session);
    const loaded = await store.load("key-1");

    expect(loaded).toBeDefined();
    expect(loaded!.sessionKey).toBe("key-1");
    expect(loaded!.transcript).toHaveLength(1);
    expect(loaded!.transcript[0]!.content).toBe("Hello");
  });

  it("updates updatedAt on save", async () => {
    const session = store.create("key-1", "agent-1");
    const original = session.updatedAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    await store.save(session);

    expect(session.updatedAt).not.toBe(original);
  });

  it("lists saved sessions (as hashed filenames)", async () => {
    await store.save(store.create("key-1", "agent-1"));
    await store.save(store.create("key-2", "agent-2"));

    const keys = await store.list();
    // Filenames are now SHA-256 hashes, not raw keys
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => /^[a-f0-9]{64}$/.test(k))).toBe(true);
  });

  it("sanitizes session keys to prevent path traversal", async () => {
    const session = store.create("../../../etc/passwd", "agent-1");
    await store.save(session);

    // The sanitized key should not contain traversal characters
    const keys = await store.list();
    expect(keys.every((k) => !k.includes(".."))).toBe(true);
  });
});
