import type { Intent } from "../types.js";
export interface ComposedMessages {
    readonly system: string;
    readonly user: string;
}
export declare function composeMessages(intent: Intent): ComposedMessages;
//# sourceMappingURL=prompts.d.ts.map