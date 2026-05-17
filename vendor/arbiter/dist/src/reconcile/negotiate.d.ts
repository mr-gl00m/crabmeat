import { type AuditDb } from "../audit/db.js";
import type { Intent, ProviderFn, Reconciliation } from "../types.js";
import { type ToolDef } from "./cone.js";
export interface NegotiateOpts {
    readonly maxRounds?: number;
    readonly catalog?: readonly ToolDef[];
    readonly auditDb?: AuditDb;
}
export declare function negotiate(intent: Intent, providerFn: ProviderFn, opts?: NegotiateOpts): Promise<Reconciliation>;
//# sourceMappingURL=negotiate.d.ts.map