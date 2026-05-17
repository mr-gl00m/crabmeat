import type { Intent } from "../types.js";
export declare const DEFAULT_PARSE_TO_CONSULT_MAX_MS = 120000;
export declare const DEFAULT_CONSULT_TO_EXECUTE_MAX_MS = 300000;
export interface ExpiryWindows {
    readonly parseToConsultMaxMs: number;
    readonly consultToExecuteMaxMs: number;
}
export interface ExpiryCheck {
    readonly ok: boolean;
    readonly reason?: string;
}
export declare function checkExpiry(intent: Intent, now: number, windows: ExpiryWindows): ExpiryCheck;
//# sourceMappingURL=expiry.d.ts.map