const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeForPrompt(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}
