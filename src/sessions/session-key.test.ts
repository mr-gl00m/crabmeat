import { describe, it, expect, afterEach } from "vitest";
import { deriveSessionKey, setSessionKeySecret } from "./session-key.js";

describe("deriveSessionKey", () => {
  it("returns a 24-char hex string", () => {
    const key = deriveSessionKey("agent-1", "chan-1", "peer-1");
    expect(key).toMatch(/^[a-f0-9]{24}$/);
  });

  it("is deterministic — same inputs produce the same key", () => {
    const a = deriveSessionKey("agent-1", "chan-1", "peer-1");
    const b = deriveSessionKey("agent-1", "chan-1", "peer-1");
    expect(a).toBe(b);
  });

  it("produces different keys for different agents", () => {
    const a = deriveSessionKey("agent-1", "chan-1", "peer-1");
    const b = deriveSessionKey("agent-2", "chan-1", "peer-1");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different channels", () => {
    const a = deriveSessionKey("agent-1", "chan-1", "peer-1");
    const b = deriveSessionKey("agent-1", "chan-2", "peer-1");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different peers", () => {
    const a = deriveSessionKey("agent-1", "chan-1", "peer-1");
    const b = deriveSessionKey("agent-1", "chan-1", "peer-2");
    expect(a).not.toBe(b);
  });

  it("handles undefined channelId and peerId", () => {
    const key = deriveSessionKey("agent-1");
    expect(key).toMatch(/^[a-f0-9]{24}$/);
  });

  it("prevents field collision via null-byte delimiters", () => {
    // "agent" + channelId="1" vs "agent1" + channelId=""
    const a = deriveSessionKey("agent", "1", "peer");
    const b = deriveSessionKey("agent1", "", "peer");
    expect(a).not.toBe(b);
  });
});

describe("RT-2026-04-30-005 — session-key secret is per-deployment", () => {
  afterEach(() => {
    // Restore the in-process default so other tests aren't affected.
    setSessionKeySecret("crabmeat-session-key-v1");
  });

  it("different deployment secrets produce different keys for the same inputs", () => {
    setSessionKeySecret("deployment-A-secret-aaaaaaaaaaaaaaaaaaaaaaaa");
    const a = deriveSessionKey("agent", "chan", "peer");

    setSessionKeySecret("deployment-B-secret-bbbbbbbbbbbbbbbbbbbbbbbb");
    const b = deriveSessionKey("agent", "chan", "peer");

    expect(a).not.toBe(b);
    // Both still well-formed 24-char hex.
    expect(a).toMatch(/^[a-f0-9]{24}$/);
    expect(b).toMatch(/^[a-f0-9]{24}$/);
  });

  it("setSessionKeySecret rejects empty input", () => {
    expect(() => setSessionKeySecret("")).toThrow();
  });
});
