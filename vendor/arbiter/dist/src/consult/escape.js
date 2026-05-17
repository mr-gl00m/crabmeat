const HTML_ENTITIES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
export function escapeForPrompt(s) {
    return s.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}
//# sourceMappingURL=escape.js.map