export const DEFAULT_TOOL_CATALOG = [
    {
        name: "file_write",
        effectClass: "write",
        required: ["filename", "content"],
        fromIntent: ["filename"],
        fromLlm: ["content"],
    },
    {
        name: "file_read",
        effectClass: "read",
        required: ["filename"],
        fromIntent: ["filename"],
        fromLlm: [],
    },
    {
        name: "web_search",
        effectClass: "search",
        required: ["query"],
        fromIntent: ["query"],
        fromLlm: [],
    },
];
export function permissionCone(intent, catalog = DEFAULT_TOOL_CATALOG) {
    return catalog.filter((t) => t.effectClass === intent.effectClass);
}
//# sourceMappingURL=cone.js.map