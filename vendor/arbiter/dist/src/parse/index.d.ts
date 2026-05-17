import { type EncodingTag } from "../normalize/index.js";
import type { Intent } from "../types.js";
export interface ParseInput {
    readonly request: string;
    readonly workspace: string;
}
export interface ParseProduct {
    readonly intent: Omit<Intent, "signature">;
    readonly decodedFrom: readonly EncodingTag[];
}
export declare function parseRequest(input: ParseInput): ParseProduct | null;
//# sourceMappingURL=index.d.ts.map