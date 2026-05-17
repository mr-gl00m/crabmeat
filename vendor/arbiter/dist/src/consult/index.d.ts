import { type AuditDb } from "../audit/db.js";
import type { Consultation, Intent, ProviderFn } from "../types.js";
export declare const DEFAULT_MAX_CONSULT_BYTES: number;
export interface ConsultRuntimeOpts {
    readonly systemPrompt?: string;
    readonly auditDb?: AuditDb;
    readonly maxConsultBytes?: number;
}
export declare function runConsult(intent: Intent, providerFn: ProviderFn, opts?: ConsultRuntimeOpts): Promise<Consultation>;
//# sourceMappingURL=index.d.ts.map