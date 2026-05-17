import { type KeyObject } from "node:crypto";
import type { Intent } from "../types.js";
export declare function canonicalize(intent: Intent | Omit<Intent, "signature">): string;
export declare function signIntent(intent: Omit<Intent, "signature">, privateKey: KeyObject): string;
export declare function verifyIntent(intent: Intent, publicKey: KeyObject): boolean;
export declare function signConsultation(intentId: string, consultedAt: number, consultationHash: string, privateKey: KeyObject): string;
export declare function verifyConsultation(intentId: string, consultedAt: number, consultationHash: string, signature: string, publicKey: KeyObject): boolean;
//# sourceMappingURL=sign.d.ts.map