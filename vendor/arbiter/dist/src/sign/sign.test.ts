import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKeyPair } from "./keys.js";
import { canonicalize, signIntent, verifyIntent } from "./sign.js";
import type { Intent } from "../types.js";

function fixtureIntent(): Omit<Intent, "signature"> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    action: "file_write",
    params: { filename: "story.txt", contentNeeded: "a story" },
    effectClass: "write",
    parsedAt: 1700000000000,
  };
}

describe("loadOrCreateKeyPair", () => {
  it("creates ed25519 PEM files on first run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const kp = await loadOrCreateKeyPair(dir);
    expect(kp.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(kp.publicKey.asymmetricKeyType).toBe("ed25519");

    const privPem = await readFile(join(dir, "ed25519.private.pem"), "utf-8");
    const pubPem = await readFile(join(dir, "ed25519.public.pem"), "utf-8");
    expect(privPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(pubPem).toMatch(/BEGIN PUBLIC KEY/);
  });

  it("reuses existing keypair on second run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const first = await loadOrCreateKeyPair(dir);
    const second = await loadOrCreateKeyPair(dir);
    const fp1 = first.publicKey.export({ type: "spki", format: "pem" });
    const fp2 = second.publicKey.export({ type: "spki", format: "pem" });
    expect(fp1).toBe(fp2);
  });
});

describe("canonicalize", () => {
  it("orders keys deterministically regardless of insertion order", () => {
    const a = canonicalize({
      id: "x",
      action: "file_write",
      params: { b: 1, a: 2 },
      effectClass: "write",
      parsedAt: 0,
    });
    const b = canonicalize({
      parsedAt: 0,
      effectClass: "write",
      params: { a: 2, b: 1 },
      action: "file_write",
      id: "x",
    });
    expect(a).toBe(b);
  });
});

describe("sign / verify", () => {
  it("verifyIntent returns true for an unaltered signed intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const kp = await loadOrCreateKeyPair(dir);
    const unsigned = fixtureIntent();
    const signature = signIntent(unsigned, kp.privateKey);
    const signed: Intent = { ...unsigned, signature };
    expect(verifyIntent(signed, kp.publicKey)).toBe(true);
  });

  it("verifyIntent returns false when intent fields are tampered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const kp = await loadOrCreateKeyPair(dir);
    const unsigned = fixtureIntent();
    const signature = signIntent(unsigned, kp.privateKey);
    const tampered: Intent = {
      ...unsigned,
      signature,
      params: { ...unsigned.params, filename: "evil.txt" },
    };
    expect(verifyIntent(tampered, kp.publicKey)).toBe(false);
  });

  it("verifyIntent returns false when signature is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const kp = await loadOrCreateKeyPair(dir);
    expect(verifyIntent(fixtureIntent() as Intent, kp.publicKey)).toBe(false);
  });

  it("verifyIntent returns false when signature is from a different key", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const dirB = await mkdtemp(join(tmpdir(), "arbiter-keys-"));
    const kpA = await loadOrCreateKeyPair(dirA);
    const kpB = await loadOrCreateKeyPair(dirB);
    const unsigned = fixtureIntent();
    const signedByA: Intent = {
      ...unsigned,
      signature: signIntent(unsigned, kpA.privateKey),
    };
    expect(verifyIntent(signedByA, kpB.publicKey)).toBe(false);
  });
});
