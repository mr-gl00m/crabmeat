import type { EffectClass, IntentAction } from "../types.js";
export interface FileWriteParse {
    readonly action: Extract<IntentAction, "file_write">;
    readonly effectClass: Extract<EffectClass, "write">;
    readonly params: {
        readonly filename: string;
        readonly absolutePath: string;
        readonly contentNeeded: string;
    };
}
export declare function parseFileWrite(text: string, workspace: string): FileWriteParse | null;
//# sourceMappingURL=file-write.d.ts.map