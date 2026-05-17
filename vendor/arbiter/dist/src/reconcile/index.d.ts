import type { Consultation, Intent, Reconciliation } from "../types.js";
import { type ToolDef } from "./cone.js";
export interface ReconcileOpts {
    readonly round?: number;
    readonly catalog?: readonly ToolDef[];
}
export declare function reconcileImpl(intent: Intent, consultation: Consultation, opts?: ReconcileOpts): Reconciliation;
//# sourceMappingURL=index.d.ts.map