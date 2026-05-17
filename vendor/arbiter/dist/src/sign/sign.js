import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
function sortedKeys(obj) {
    if (obj === null || typeof obj !== "object")
        return obj;
    if (Array.isArray(obj))
        return obj.map(sortedKeys);
    const src = obj;
    const sorted = {};
    for (const k of Object.keys(src).sort()) {
        sorted[k] = sortedKeys(src[k]);
    }
    return sorted;
}
function signedPayload(intent) {
    const out = {
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
export function canonicalize(intent) {
    return JSON.stringify(sortedKeys(signedPayload(intent)));
}
export function signIntent(intent, privateKey) {
    const data = Buffer.from(canonicalize(intent), "utf-8");
    return cryptoSign(null, data, privateKey).toString("base64");
}
export function verifyIntent(intent, publicKey) {
    if (intent.signature === undefined)
        return false;
    const data = Buffer.from(canonicalize(intent), "utf-8");
    try {
        return cryptoVerify(null, data, publicKey, Buffer.from(intent.signature, "base64"));
    }
    catch {
        return false;
    }
}
// RT-2026-04-30-010 — bind consultedAt + consultation hash with a separate
// signature so a tampered consultedAt cannot bypass the consult→execute
// window. Kept distinct from signIntent to keep parse-time signing pure.
function consultationBytes(intentId, consultedAt, consultationHash) {
    return Buffer.from(`${intentId}|${consultedAt}|${consultationHash}`, "utf-8");
}
export function signConsultation(intentId, consultedAt, consultationHash, privateKey) {
    return cryptoSign(null, consultationBytes(intentId, consultedAt, consultationHash), privateKey).toString("base64");
}
export function verifyConsultation(intentId, consultedAt, consultationHash, signature, publicKey) {
    try {
        return cryptoVerify(null, consultationBytes(intentId, consultedAt, consultationHash), publicKey, Buffer.from(signature, "base64"));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=sign.js.map