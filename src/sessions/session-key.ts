import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../infra/fs.js";

/**
 * Per-deployment secret for the session-key HMAC. Loaded once at gateway
 * startup from `.crabmeat/session-key-secret` (mint-on-first-run, mirrors
 * `.crabmeat/cap-secret`). Without this, the HMAC key was a hardcoded
 * string and any token-holder could compute another token-holder's
 * sessionKey — fine for single-user, owned in shared deployments.
 * RT-2026-04-30-005.
 *
 * Tests and pre-startup callers fall back to the legacy compiled-in
 * value, so unit tests that don't init the secret still produce stable
 * keys for the same inputs (no behavioral break for in-process tests).
 */
const LEGACY_SECRET = "crabmeat-session-key-v1";
const SESSION_KEY_SECRET_PATH = join(".crabmeat", "session-key-secret");
let activeSecret: string = LEGACY_SECRET;

export function setSessionKeySecret(secret: string): void {
  if (secret.length === 0) {
    throw new Error("setSessionKeySecret: secret must not be empty");
  }
  activeSecret = secret;
}

export async function loadOrCreateSessionKeySecret(): Promise<string> {
  try {
    const existing = (await readFile(SESSION_KEY_SECRET_PATH, "utf-8")).trim();
    if (existing.length > 0) {
      activeSecret = existing;
      return existing;
    }
  } catch {
    // Missing or unreadable — fall through to mint a fresh one.
  }
  const fresh = randomBytes(32).toString("hex");
  await writeFileAtomic(SESSION_KEY_SECRET_PATH, fresh);
  activeSecret = fresh;
  return fresh;
}

/**
 * Derive a deterministic session key from routing context.
 * Same (agentId, channelId, peerId) always produces the same key,
 * so reconnecting clients resume the same session.
 *
 * Uses HMAC-SHA256 with a per-deployment secret and null-byte delimiters
 * to prevent collision between fields (e.g. "user_A" + "B" vs "userA_" + "B").
 */
export function deriveSessionKey(
  agentId: string,
  channelId?: string,
  peerId?: string,
): string {
  const input = [agentId, channelId ?? "", peerId ?? ""].join("\0");
  return createHmac("sha256", activeSecret)
    .update(input)
    .digest("hex")
    .slice(0, 24);
}
