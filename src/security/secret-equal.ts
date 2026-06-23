import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe string comparison. Both values are hashed with SHA-256
 * before comparison to guarantee constant-time regardless of input
 * length mismatch.
 */
export function secretEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
