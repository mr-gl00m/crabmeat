export function parseProposal(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return null;
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    const candidate = fenceMatch?.[1] ?? trimmed;
    let raw;
    try {
        raw = JSON.parse(candidate);
    }
    catch {
        const objMatch = /\{[\s\S]*\}/.exec(candidate);
        if (objMatch === null)
            return null;
        try {
            raw = JSON.parse(objMatch[0]);
        }
        catch {
            return null;
        }
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const obj = raw;
    if (typeof obj["tool"] !== "string" || obj["tool"].length === 0)
        return null;
    const args = obj["args"];
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return null;
    }
    return { tool: obj["tool"], args: args };
}
//# sourceMappingURL=proposal.js.map