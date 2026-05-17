import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../io/atomic.js";
import { loadEnv } from "../env.js";
import { loadOrCreateKeyPairSync } from "../sign/keys.js";
import { verifyIntent } from "../sign/sign.js";
export const HITL_EFFECT_CLASSES = new Set([
    "exec",
    "network",
    "privileged",
]);
export function requiresHitl(intent) {
    return HITL_EFFECT_CLASSES.has(intent.effectClass);
}
function defaultPendingDir() {
    const stateDir = loadEnv().ARBITER_STATE_DIR ?? join(homedir(), ".arbiter");
    return join(stateDir, "pending");
}
export function hitlPaths(intent, dir) {
    const root = dir ?? defaultPendingDir();
    return {
        pendingPath: join(root, `${intent.id}.json`),
        signedPath: join(root, `${intent.id}.signed`),
    };
}
export async function writePendingAndWait(intent, reconciliation, opts = {}) {
    const { pendingPath, signedPath } = hitlPaths(intent, opts.dir);
    const interval = opts.pollIntervalMs ?? 200;
    const timeout = opts.timeoutMs ?? 60_000;
    await atomicWriteJson(pendingPath, {
        intentId: intent.id,
        intent,
        reconciliation,
        writtenAt: Date.now(),
    });
    const publicKey = loadOrCreateKeyPairSync().publicKey;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (existsSync(signedPath)) {
            // Signed file contents must be a base64 Ed25519 signature over
            // canonicalize(intent), produced with the arbiter signing key. Bare
            // existence is not an approval — RT-2026-04-30-001.
            const sigB64 = (await fs.readFile(signedPath, "utf-8").catch(() => "")).trim();
            if (sigB64.length > 0) {
                const probe = { ...intent, signature: sigB64 };
                if (verifyIntent(probe, publicKey)) {
                    return { approved: true, pendingPath, signedPath };
                }
            }
            // Invalid or unreadable signature: keep polling until a valid one
            // appears or the window closes. The operator can overwrite.
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return {
        approved: false,
        reason: `HITL approval timeout after ${timeout}ms`,
        pendingPath,
        signedPath,
    };
}
//# sourceMappingURL=hitl.js.map