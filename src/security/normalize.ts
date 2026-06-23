/**
 * Input normalization — detects and decodes obfuscated payloads.
 *
 * Attackers encode prompt-injection strings using Base64, ROT13,
 * leetspeak, Unicode homoglyphs, and invisible characters to sneak
 * past pattern-based filters.  This module:
 *
 *  1. Strips invisible / zero-width characters.
 *  2. Normalizes Unicode homoglyphs via NFKC.
 *  3. Detects embedded Base64-encoded segments.
 *  4. Detects ROT13-encoded segments.
 *  5. Decodes leetspeak substitutions.
 *
 * Each detector returns a label added to `TrustMeta.sigilDetections`
 * so downstream trust decisions can account for obfuscation attempts.
 */

import { logger } from "../infra/logger.js";

// ── Types ───────────────────────────────────────────────────

export interface NormalizationResult {
  /** The cleaned / decoded text (safe for pipeline consumption). */
  normalized: string;
  /** Labels for every obfuscation technique detected. */
  detections: string[];
}

// ── Invisible character stripping ───────────────────────────

/**
 * Zero-width and formatting characters used to split tokens or
 * hide content from pattern matchers.
 */
const INVISIBLE_RE =
  /[\u200B-\u200F\u2028-\u202F\u2060-\u2064\u2066-\u206F\uFEFF\u00AD\u034F\u061C\u180E\uFFF9-\uFFFB]/g;

function stripInvisible(input: string): { text: string; found: boolean } {
  const found = INVISIBLE_RE.test(input);
  INVISIBLE_RE.lastIndex = 0;
  return { text: input.replace(INVISIBLE_RE, ""), found };
}

// ── Unicode homoglyph normalization ─────────────────────────

/**
 * NFKC folds compatibility characters: ꜱ→s, ﬁ→fi, ℌ→H, etc.
 * We compare before/after to detect whether homoglyphs were present.
 */
function normalizeHomoglyphs(input: string): { text: string; found: boolean } {
  const normed = input.normalize("NFKC");
  return { text: normed, found: normed !== input };
}

// ── Base64 detection ────────────────────────────────────────

/**
 * Match plausible Base64 segments (≥16 chars, standard or URL-safe
 * alphabet, optional padding). Short segments are ignored to avoid
 * false positives on normal English words.
 */
const BASE64_RE = /[A-Za-z0-9+/\-_]{16,}={0,2}/g;

function detectBase64(input: string): { decoded: string; found: boolean } {
  BASE64_RE.lastIndex = 0;
  let result = input;
  let found = false;

  const matches = input.match(BASE64_RE);
  if (!matches) return { decoded: input, found: false };

  for (const m of matches) {
    try {
      // Normalize URL-safe Base64 to standard
      const std = m.replace(/-/g, "+").replace(/_/g, "/");
      const buf = Buffer.from(std, "base64");
      // Validate round-trip to reject accidental matches
      const reEncoded = buf.toString("base64").replace(/=+$/, "");
      const mClean = std.replace(/=+$/, "");
      if (reEncoded !== mClean) continue;
      // Only flag if decoded content looks like text (>90% printable ASCII)
      const decoded = buf.toString("utf-8");
      const printable = decoded.replace(/[^\x20-\x7E]/g, "");
      if (printable.length / decoded.length < 0.9) continue;
      result = result.replace(m, decoded);
      found = true;
    } catch {
      // Not valid Base64 — ignore
    }
  }

  return { decoded: result, found };
}

// ── ROT13 detection ─────────────────────────────────────────

/**
 * ROT13 rotate.
 */
function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * Heuristic: ROT13-decode the input and check if the decoded version
 * contains more recognisable English words than the original.
 * Only flags if the input contains suspicious ROT13 markers.
 */
const ROT13_MARKER_RE = /\bROT13\b|\bEBG13\b|\brot13[:(]/i;

function detectRot13(input: string): { decoded: string; found: boolean } {
  if (!ROT13_MARKER_RE.test(input)) {
    return { decoded: input, found: false };
  }
  // Decode the entire input and replace
  return { decoded: rot13(input), found: true };
}

// ── Leetspeak decoding ──────────────────────────────────────

const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "@": "a", "$": "s", "!": "i", "|": "l",
};

const LEET_RE = /[013457@$!|]/g;

/**
 * A token is "leet" if it contains BOTH alphabetic characters AND
 * ≥2 leet substitution characters. Pure numbers ("100"), standalone
 * digits ("1"), and normal words are never treated as leetspeak.
 *
 * Replacement is scoped to qualifying tokens only — nearby numbers
 * and normal text are left untouched.
 */
const ALPHA_RE = /[a-zA-Z]/;

function isLeetToken(token: string): boolean {
  if (!ALPHA_RE.test(token)) return false;
  let leetCount = 0;
  for (const ch of token) {
    if (ch in LEET_MAP) leetCount++;
    if (leetCount >= 2) return true;
  }
  return false;
}

function detectLeetspeak(input: string): { decoded: string; found: boolean } {
  // Split on whitespace, decode only qualifying tokens, rejoin.
  const tokens = input.split(/(\s+)/); // capture separators to preserve spacing
  let found = false;
  const rebuilt: string[] = [];
  for (const tok of tokens) {
    if (isLeetToken(tok)) {
      found = true;
      rebuilt.push(tok.replace(LEET_RE, (ch) => LEET_MAP[ch] ?? ch));
    } else {
      rebuilt.push(tok);
    }
  }
  return { decoded: found ? rebuilt.join("") : input, found };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Run all normalizers on input text. Returns the cleaned text and
 * a list of detection labels for TrustMeta.sigilDetections.
 */
export function normalizeInput(input: string): NormalizationResult {
  const detections: string[] = [];
  let text = input;

  // 1. Strip invisible characters
  const inv = stripInvisible(text);
  if (inv.found) {
    detections.push("invisible_chars");
    text = inv.text;
  }

  // 2. Unicode homoglyph normalization (NFKC)
  const hom = normalizeHomoglyphs(text);
  if (hom.found) {
    detections.push("unicode_homoglyphs");
    text = hom.text;
  }

  // 3. Base64 detection & inline decode
  const b64 = detectBase64(text);
  if (b64.found) {
    detections.push("base64_encoded");
    text = b64.decoded;
  }

  // 4. ROT13 detection & decode
  const r13 = detectRot13(text);
  if (r13.found) {
    detections.push("rot13_encoded");
    text = r13.decoded;
  }

  // 5. Leetspeak detection & decode
  const leet = detectLeetspeak(text);
  if (leet.found) {
    detections.push("leetspeak");
    text = leet.decoded;
  }

  if (detections.length > 0) {
    logger.info(
      { detections, originalLength: input.length, normalizedLength: text.length },
      "Input normalization detected obfuscation",
    );
  }

  return { normalized: text, detections };
}
