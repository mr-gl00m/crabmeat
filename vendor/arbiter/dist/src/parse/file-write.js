import { jailPath, looksFileLike } from "./path-jail.js";
import { trimTerminalPunct } from "./trim.js";
const FILE_WRITE_RE = /\b(?:write|save|create|put|store)\s+(?:me\s+|us\s+|out\s+)?(.+?)\s+(?:to|into|at|in)\s+(\S+)/i;
export function parseFileWrite(text, workspace) {
    const m = FILE_WRITE_RE.exec(text);
    if (m === null)
        return null;
    const contentNeeded = m[1]?.trim() ?? "";
    const destination = trimTerminalPunct(m[2] ?? "");
    if (contentNeeded.length === 0 || destination.length === 0)
        return null;
    if (!looksFileLike(destination))
        return null;
    const jailed = jailPath(destination, workspace);
    if (!jailed.ok || jailed.path === undefined)
        return null;
    return {
        action: "file_write",
        effectClass: "write",
        params: {
            filename: destination,
            absolutePath: jailed.path,
            contentNeeded,
        },
    };
}
//# sourceMappingURL=file-write.js.map