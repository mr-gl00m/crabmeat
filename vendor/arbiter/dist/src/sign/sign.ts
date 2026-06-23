import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { Intent } from "../types.js";

function sortedKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortedKeys);
  const src = obj as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    sorted[k] = sortedKeys(src[k]);
  }
  return sorted;
}

interface SignedPayload {
  readonly id: string;
  readonly action: Intent["action"];
  readonly params: Intent["params"];
  readonly effectClass: Intent["effectClass"];
  readonly parsedAt: number;
  readonly decodedFrom?: string;
}

function signedPayload(
  intent: Intent | Omit<Intent, "signature">,
): SignedPayload {
  const out: SignedPayload = {
    id: intent.id,
    action: intent.action,
    params: intent.params,
    effectClass: intent.effectClass,
    parsedAt: intent.parsedAt,
    ...(intent.decodedFrom !== undefined
      ? { decodedFrom: intent.decodedFrom }
      : {}),
  };
  return out;
}

export function canonicalize(
  intent: Intent | Omit<Intent, "signature">,
): string {
  return JSON.stringify(sortedKeys(signedPayload(intent)));
}

export function signIntent(
  intent: Omit<Intent, "signature">,
  privateKey: KeyObject,
): string {
  const data = Buffer.from(canonicalize(intent), "utf-8");
  return cryptoSign(null, data, privateKey).toString("base64");
}

export function verifyIntent(intent: Intent, publicKey: KeyObject): boolean {
  if (intent.signature === undefined) return false;
  const data = Buffer.from(canonicalize(intent), "utf-8");
  try {
    return cryptoVerify(
      null,
      data,
      publicKey,
      Buffer.from(intent.signature, "base64"),
    );
  } catch {
    return false;
  }
}

// RT-2026-04-30-010 — bind consultedAt + consultation hash with a separate
// signature so a tampered consultedAt cannot bypass the consult→execute
// window. Kept distinct from signIntent to keep parse-time signing pure.
function consultationBytes(
  intentId: string,
  consultedAt: number,
  consultationHash: string,
): Buffer {
  return Buffer.from(`${intentId}|${consultedAt}|${consultationHash}`, "utf-8");
}

export function signConsultation(
  intentId: string,
  consultedAt: number,
  consultationHash: string,
  privateKey: KeyObject,
): string {
  return cryptoSign(
    null,
    consultationBytes(intentId, consultedAt, consultationHash),
    privateKey,
  ).toString("base64");
}

export function verifyConsultation(
  intentId: string,
  consultedAt: number,
  consultationHash: string,
  signature: string,
  publicKey: KeyObject,
): boolean {
  try {
    return cryptoVerify(
      null,
      consultationBytes(intentId, consultedAt, consultationHash),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
