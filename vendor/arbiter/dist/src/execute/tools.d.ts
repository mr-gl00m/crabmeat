import type { Result } from "../types.js";
export declare const DEFAULT_MAX_FILE_READ_BYTES: number;
export declare function execFileWrite(args: Record<string, unknown>, workspace: string): Promise<Result>;
export declare function execFileRead(args: Record<string, unknown>, workspace: string, maxBytes?: number): Promise<Result>;
export declare function execWebSearch(args: Record<string, unknown>): Result;
//# sourceMappingURL=tools.d.ts.map