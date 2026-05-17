const ACTION_HEAD = /^\s*(?:also\s+|then\s+|next\s+)?(?:please\s+)?(read|write|save|create|open|load|show|search|find|fetch|get|delete|remove|put|store)\b/i;
export function isCompound(text) {
    const parts = text.split(/\b(?:and|then)\b/i);
    if (parts.length < 2)
        return false;
    let n = 0;
    for (const p of parts) {
        if (ACTION_HEAD.test(p))
            n++;
    }
    return n >= 2;
}
//# sourceMappingURL=compound.js.map