import type { EffectClass, IntentAction } from "../types.js";
export interface FileReadParse {
    readonly action: Extract<IntentAction, "file_read">;
    readonly effectClass: Extract<EffectClass, "read">;
    readonly params: {
        readonly filename: string;
        readonly absolutePath: string;
    };
}
export declare function parseFileRead(text: string, workspace: string): FileReadParse | null;
//# sourceMappingURL=file-read.d.ts.map