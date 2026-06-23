const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const URL_PCT_RE = /%[0-9A-Fa-f]{2}/;
const PRINTABLE_RE = /^[\x09\x0A\x0D\x20-\x7E]+$/;

export function looksLikeBase64(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 8 || trimmed.length % 4 !== 0) return false;
  return BASE64_RE.test(trimmed);
}

export function tryBase64(s: string): string | null {
  if (!looksLikeBase64(s)) return null;
  try {
    const out = Buffer.from(s.trim(), "base64").toString("utf-8");
    return PRINTABLE_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function looksLikeHex(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 8 || trimmed.length % 2 !== 0) return false;
  return HEX_RE.test(trimmed);
}

export function tryHex(s: string): string | null {
  if (!looksLikeHex(s)) return null;
  try {
    const out = Buffer.from(s.trim(), "hex").toString("utf-8");
    return PRINTABLE_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function tryUrlDecode(s: string): string | null {
  if (!URL_PCT_RE.test(s)) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function applyRot13(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(((code - 65 + 13) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      out += String.fromCharCode(((code - 97 + 13) % 26) + 97);
    } else {
      out += s[i];
    }
  }
  return out;
}
