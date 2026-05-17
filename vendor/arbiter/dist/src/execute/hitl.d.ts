import type { EffectClass, Intent, Reconciliation } from "../types.js";
export declare const HITL_EFFECT_CLASSES: ReadonlySet<EffectClass>;
export declare function requiresHitl(intent: Intent): boolean;
export interface HitlPaths {
    readonly pendingPath: string;
    readonly signedPath: string;
}
export declare function hitlPaths(intent: Intent, dir?: string): HitlPaths;
export interface HitlOpts {
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly dir?: string;
}
export interface HitlWaitResult {
    readonly approved: boolean;
    readonly reason?: string;
    readonly pendingPath: string;
    readonly signedPath: string;
}
export declare function writePendingAndWait(intent: Intent, reconciliation: Reconciliation, opts?: HitlOpts): Promise<HitlWaitResult>;
//# sourceMappingURL=hitl.d.ts.map