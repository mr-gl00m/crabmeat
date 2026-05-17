import { jailPath, looksFileLike } from "./path-jail.js";
import { trimTerminalPunct } from "./trim.js";
const FILE_READ_RE = /\b(?:read|open|load|show|cat)\s+(?:the\s+)?(?:contents?\s+of\s+)?(\S+)/i;
export function parseFileRead(text, workspace) {
    const m = FILE_READ_RE.exec(text);
    if (m === null)
        return null;
    const target = trimTerminalPunct(m[1] ?? "");
    if (target.length === 0)
        return null;
    if (!looksFileLike(target))
        return null;
    const jailed = jailPath(target, workspace);
    if (!jailed.ok || jailed.path === undefined)
        return null;
    return {
        action: "file_read",
        effectClass: "read",
        params: {
            filename: target,
            absolutePath: jailed.path,
        },
    };
}
//# sourceMappingURL=file-read.js.map