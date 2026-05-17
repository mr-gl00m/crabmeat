import type { EffectClass, Intent } from "../types.js";
export interface ToolDef {
    readonly name: string;
    readonly effectClass: EffectClass;
    readonly required: readonly string[];
    readonly fromIntent: readonly string[];
    readonly fromLlm: readonly string[];
}
export declare const DEFAULT_TOOL_CATALOG: readonly ToolDef[];
export declare function permissionCone(intent: Intent, catalog?: readonly ToolDef[]): readonly ToolDef[];
//# sourceMappingURL=cone.d.ts.map