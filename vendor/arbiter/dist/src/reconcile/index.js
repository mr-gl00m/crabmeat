import { DEFAULT_TOOL_CATALOG, permissionCone, } from "./cone.js";
import { parseProposal } from "./proposal.js";
export function reconcileImpl(intent, consultation, opts = {}) {
    const round = opts.round ?? 1;
    const catalog = opts.catalog ?? DEFAULT_TOOL_CATALOG;
    const cone = permissionCone(intent, catalog);
    const coneNames = cone.map((t) => t.name);
    const proposal = parseProposal(consultation.text);
    if (proposal === null) {
        return {
            outcome: "rejected",
            reason: "proposal not parseable as a JSON object with {tool, args}",
            round,
        };
    }
    const tool = cone.find((t) => t.name === proposal.tool);
    if (tool === undefined) {
        return {
            outcome: "rejected",
            reason: `tool "${proposal.tool}" not in permission cone for ${intent.action} (allowed: ${coneNames.join(", ") || "none"})`,
            round,
        };
    }
    const intentParams = intent.params;
    const merged = {};
    let refinedReason;
    for (const arg of tool.fromIntent) {
        const expected = intentParams[arg];
        if (expected === undefined) {
            return {
                outcome: "rejected",
                reason: `intent missing required field "${arg}"`,
                round,
            };
        }
        const proposed = proposal.args[arg];
        if (proposed !== undefined && proposed !== expected) {
            refinedReason = `${arg} overridden by intent (proposed=${JSON.stringify(proposed)}, intent=${JSON.stringify(expected)})`;
        }
        merged[arg] = expected;
    }
    for (const arg of tool.fromLlm) {
        const v = proposal.args[arg];
        if (typeof v !== "string" || v.length === 0) {
            return {
                outcome: "rejected",
                reason: `proposal missing required arg "${arg}" from LLM`,
                round,
            };
        }
        merged[arg] = v;
    }
    if (refinedReason !== undefined) {
        return { outcome: "refined", reason: refinedReason, round, args: merged };
    }
    return {
        outcome: "approved",
        reason: "proposal matches intent",
        round,
        args: merged,
    };
}
//# sourceMappingURL=index.js.map