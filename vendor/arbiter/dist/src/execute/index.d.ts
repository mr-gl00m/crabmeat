import { type AuditDb } from "../audit/db.js";
import { type HitlOpts } from "./hitl.js";
import type { ExecuteArgs, Intent, Result } from "../types.js";
export interface ExecuteRuntimeOpts {
    readonly workspace?: string;
    readonly auditDb?: AuditDb;
    readonly parseToConsultMaxMs?: number;
    readonly consultToExecuteMaxMs?: number;
    readonly hitl?: HitlOpts;
    readonly skipHitl?: boolean;
}
export declare function runExecute(intent: Intent, args?: ExecuteArgs, opts?: ExecuteRuntimeOpts): Promise<Result>;
//# sourceMappingURL=index.d.ts.map