import { initAuditDb } from "../audit/db.js";
import { appendAuditRow } from "../audit/append.js";
import { sha256Hex } from "../audit/hash.js";
import { loadOrCreateKeyPairSync } from "../sign/keys.js";
import { signConsultation } from "../sign/sign.js";
import { composeMessages } from "./prompts.js";
// RT-2026-04-30-003 — cap accumulated provider output. A misbehaving or runaway
// stream cannot OOM the host process. 2 MiB is well above realistic short-form
// content; consumers needing more can override via ConsultOpts.maxConsultBytes.
export const DEFAULT_MAX_CONSULT_BYTES = 2 * 1024 * 1024;
export async function runConsult(intent, providerFn, opts = {}) {
    const messages = composeMessages(intent);
    const systemContent = opts.systemPrompt ?? messages.system;
    const maxBytes = opts.maxConsultBytes ?? DEFAULT_MAX_CONSULT_BYTES;
    const parts = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of providerFn([
        { role: "system", content: systemContent },
        { role: "user", content: messages.user },
    ])) {
        const remaining = maxBytes - total;
        if (remaining <= 0) {
            truncated = true;
            break;
        }
        if (chunk.delta.length > remaining) {
            parts.push(chunk.delta.slice(0, remaining));
            total = maxBytes;
            truncated = true;
            break;
        }
        parts.push(chunk.delta);
        total += chunk.delta.length;
    }
    const text = parts.join("");
    const receivedAt = Date.now();
    const hash = sha256Hex(text);
    intent.consultedAt = receivedAt;
    // RT-2026-04-30-010 — bind consultedAt + hash with a second signature.
    const kp = loadOrCreateKeyPairSync();
    intent.consultationSignature = signConsultation(intent.id, receivedAt, hash, kp.privateKey);
    const db = opts.auditDb ?? initAuditDb();
    const owns = opts.auditDb === undefined;
    try {
        appendAuditRow(db, {
            kind: "consultation",
            intentId: intent.id,
            payload: {
                intentId: intent.id,
                hash,
                length: text.length,
                receivedAt,
                consultedAt: receivedAt,
                ...(truncated ? { truncated: true, maxBytes } : {}),
            },
        });
    }
    finally {
        if (owns)
            db.close();
    }
    return { intentId: intent.id, text, hash, receivedAt };
}
//# sourceMappingURL=index.js.map