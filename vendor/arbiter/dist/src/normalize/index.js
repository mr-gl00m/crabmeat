import { normalizeCharset } from "./homoglyph.js";
import { applyRot13, tryBase64, tryHex, tryUrlDecode } from "./encodings.js";
const TRIGGER_WORDS = [
    "write",
    "read",
    "search",
    "fetch",
    "story",
    "save",
    "load",
    "open",
    "find",
    "lookup",
    "to ",
    "into ",
    "from ",
    "about ",
    "at ",
];
const SUSPICIOUS_TOKENS = ["../", "..\\", "/etc/", "/root/", "C:\\"];
function score(s) {
    const lower = s.toLowerCase();
    let n = 0;
    for (const w of TRIGGER_WORDS) {
        if (lower.includes(w))
            n += 2;
    }
    for (const t of SUSPICIOUS_TOKENS) {
        if (lower.includes(t.toLowerCase()))
            n += 3;
    }
    return n;
}
export function normalize(input) {
    const tags = [];
    let current = input;
    const charsetFolded = normalizeCharset(current);
    if (charsetFolded !== current)
        tags.push("homoglyph");
    current = charsetFolded;
    const candidates = [];
    const url = tryUrlDecode(current);
    if (url !== null && url !== current)
        candidates.push({ tag: "url", text: url });
    const b64 = tryBase64(current);
    if (b64 !== null)
        candidates.push({ tag: "base64", text: b64 });
    const hex = tryHex(current);
    if (hex !== null)
        candidates.push({ tag: "hex", text: hex });
    const rot = applyRot13(current);
    if (rot !== current)
        candidates.push({ tag: "rot13", text: rot });
    const baseScore = score(current);
    let best = null;
    for (const c of candidates) {
        const s = score(c.text);
        if (s > baseScore && (best === null || s > best.score)) {
            best = { ...c, score: s };
        }
    }
    if (best !== null) {
        tags.push(best.tag);
        current = best.text;
    }
    return { normalized: current, decodedFrom: tags };
}
//# sourceMappingURL=index.js.map