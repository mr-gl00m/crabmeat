import type { EffectClass, IntentAction } from "../types.js";
export interface WebSearchParse {
    readonly action: Extract<IntentAction, "web_search">;
    readonly effectClass: Extract<EffectClass, "search" | "network">;
    readonly params: {
        readonly query: string;
    };
}
export declare function searchAllowlist(): readonly string[];
export declare function parseWebSearch(text: string): WebSearchParse | null;
//# sourceMappingURL=web-search.d.ts.map