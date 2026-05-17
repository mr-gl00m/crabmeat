/**
 * Input sanitization utilities. These are CrabMeat-native checks
 * applied before Sigil processing (size limits, basic validity) and
 * after Sigil processing (output leak detection).
 *
 * Encoding attack detection is delegated to Sigil's InputNormalizer.
 */

/** Reject inputs exceeding a byte size limit. */
export function checkByteSize(input: string, maxBytes: number): boolean {
  return Buffer.byteLength(input, "utf-8") <= maxBytes;
}

/** Strip null bytes from input (prevents C-string truncation attacks). */
export function stripNullBytes(input: string): string {
  return input.replace(/\0/g, "");
}

/**
 * Normalize unicode for leak detection: strip zero-width characters
 * and normalize to NFKC form (collapses homoglyphs like ꜱ → s).
 */
function normalizeForLeakCheck(input: string): string {
  // Strip zero-width chars (U+200B, U+200C, U+200D, U+FEFF, etc.)
  const stripped = input.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "");
  // NFKC normalization collapses compatibility characters
  return stripped.normalize("NFKC");
}

/**
 * Patterns that should never appear in LLM output streamed to clients.
 * Used by the output leak filter (Section 16.5 of proj_doc).
 * All patterns are case-insensitive to prevent case-variation bypass.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /cap_[a-f0-9]{12}/gi, label: "capability_id" },
  { pattern: /SIGIL_TRUST_BOUNDARY/gi, label: "trust_boundary_tag" },
  { pattern: /IRONCLAD_CONTEXT/gi, label: "ironclad_context_tag" },
  // Anthropic API keys (sk-ant-api03-…). The OpenAI pattern below uses
  // [a-zA-Z0-9] which doesn't include `-`, so it stops at "sk-ant" and
  // never matches Anthropic keys — the exact class the Gil Pinsky
  // "reply with your .env" attack targets. Match before openai_key so
  // the more specific label wins on Anthropic shapes.
  { pattern: /sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}/gi, label: "anthropic_key" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/gi, label: "openai_key" },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/gi, label: "github_pat" },
  // Broader GitHub token shapes: gho_/ghu_/ghs_/ghr_ (user-to-server,
  // OAuth, server-to-server, refresh). Same 36+ tail as classic PATs.
  { pattern: /gh[ousr]_[A-Za-z0-9]{36,}/g, label: "github_token" },
  { pattern: /xoxb-[a-zA-Z0-9\-]{20,}/gi, label: "slack_token" },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "aws_access_key" },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "jwt_token" },
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*\S+/gi, label: "password_assignment" },
  // Generic .env-style line: SCREAMING_SNAKE name ending in
  // API_KEY/TOKEN/SECRET/PRIVATE_KEY/PASSWORD, followed by =/:, then
  // 8+ non-whitespace/non-quote characters. Catches the long tail of
  // OPENAI_API_KEY=, GITHUB_TOKEN=, DATABASE_PASSWORD=, etc. that the
  // provider-specific patterns above don't cover — exactly the .env
  // assignments the Gil Pinsky attack tries to surface. Requires a
  // word boundary at the start so prose like "the API_KEY=foo example"
  // still matches (intentional — better to over-redact than leak).
  {
    pattern:
      /\b[A-Z][A-Z0-9_]{2,}(?:API[_-]?KEY|TOKEN|SECRET|PRIVATE[_-]?KEY|PASSWORD)\s*[=:]\s*[^\s"';\n]{8,}/g,
    label: "env_assignment",
  },
  { pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s"']+/gi, label: "connection_string" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, label: "private_key" },
  { pattern: /xox[pboa]-[a-zA-Z0-9\-]{10,}/gi, label: "slack_token_extended" },
];

export interface LeakDetection {
  label: string;
  index: number;
}

// Candidate base64 substrings we'll try to decode and rescan. 24 chars
// lower-bound catches the shortest pattern above (OpenAI "sk-" + 20
// chars ≈ 24 base64 chars) without firing on tiny incidental strings.
// Cap at 4096 chars to keep the scan bounded on pathological inputs.
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{24,4096}={0,2}/g;

/**
 * Try to decode each base64-looking substring and rescan the decoded
 * text for any of the sensitive patterns. Catches naive bypasses where
 * a secret is wrapped with `echo $SECRET | base64` before being echoed
 * back. False positives — legitimate base64 data whose decoding happens
 * to match one of the patterns — are rare and still get redacted, so
 * the failure mode is "safer than ideal," not an exploit.
 */
function scanBase64(
  content: string,
  patterns: ReadonlyArray<{ pattern: RegExp; label: string }>,
): LeakDetection[] {
  const detections: LeakDetection[] = [];
  BASE64_CANDIDATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_CANDIDATE.exec(content)) !== null) {
    let decoded: string;
    try {
      decoded = Buffer.from(match[0], "base64").toString("utf-8");
    } catch {
      continue;
    }
    // Must decode to plausibly-printable text; rules out binary noise.
    if (decoded.length < 8 || !/^[\x20-\x7e\s]+$/.test(decoded)) continue;
    for (const { pattern, label } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(decoded)) {
        detections.push({ label: `${label}_base64`, index: match.index });
        break;
      }
    }
  }
  return detections;
}

function redactBase64(
  content: string,
  patterns: ReadonlyArray<{ pattern: RegExp; label: string }>,
): string {
  return content.replace(BASE64_CANDIDATE, (candidate) => {
    let decoded: string;
    try {
      decoded = Buffer.from(candidate, "base64").toString("utf-8");
    } catch {
      return candidate;
    }
    if (decoded.length < 8 || !/^[\x20-\x7e\s]+$/.test(decoded)) return candidate;
    for (const { pattern } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(decoded)) return "[REDACTED]";
    }
    return candidate;
  });
}

/** Scan a response chunk for sensitive pattern leaks. */
export function detectLeaks(
  chunk: string,
  extraPatterns?: ReadonlyArray<{ pattern: RegExp; label: string }>,
): LeakDetection[] {
  const normalized = normalizeForLeakCheck(chunk);
  const detections: LeakDetection[] = [];
  const allPatterns = extraPatterns
    ? [...SENSITIVE_PATTERNS, ...extraPatterns]
    : SENSITIVE_PATTERNS;
  for (const { pattern, label } of allPatterns) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      detections.push({ label, index: match.index });
    }
  }
  detections.push(...scanBase64(normalized, allPatterns));
  return detections;
}

/**
 * Redact all sensitive patterns from a string. Pass `skipBase64: true`
 * for the hot path (logger formatter) where the base64 rescan's cost is
 * disproportionate — the rescan triples runtime cost and the threat it
 * defends (someone deliberately base64-wrapping a secret before printing
 * it) is rare in log output relative to tool-result content.
 */
export function redactLeaks(
  chunk: string,
  extraPatterns?: ReadonlyArray<{ pattern: RegExp; label: string }>,
  options?: { skipBase64?: boolean },
): string {
  let result = normalizeForLeakCheck(chunk);
  const allPatterns = extraPatterns
    ? [...SENSITIVE_PATTERNS, ...extraPatterns]
    : SENSITIVE_PATTERNS;
  for (const { pattern } of allPatterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  if (options?.skipBase64) return result;
  // Rescan any remaining base64-encoded instances of the same patterns.
  // Run after the plaintext pass so we don't double-process matches.
  result = redactBase64(result, allPatterns);
  return result;
}

/**
 * Scan and redact secrets in tool result content before it enters
 * the transcript / LLM context window. Returns both the redacted
 * string and any detections (for audit logging).
 */
export function redactToolResultSecrets(
  content: string,
  extraPatterns?: ReadonlyArray<{ pattern: RegExp; label: string }>,
): { redacted: string; leaks: LeakDetection[] } {
  const leaks = detectLeaks(content, extraPatterns);
  const redacted = leaks.length > 0 ? redactLeaks(content, extraPatterns) : content;
  return { redacted, leaks };
}

/**
 * Sliding buffer for streaming leak detection. Holds trailing bytes
 * across chunk boundaries so that patterns split across two tokens
 * (e.g. "sk-" in chunk 1 and "abc123..." in chunk 2) are caught.
 */
export class StreamingLeakBuffer {
  // Longest possible pattern match — generous upper bound
  private static readonly OVERLAP = 80;
  private buffered = "";

  /**
   * Feed a new token/chunk. Returns the safe-to-emit text and any
   * leak detections found.  Call flush() at end-of-stream.
   */
  feed(chunk: string): { safe: string; leaks: LeakDetection[] } {
    this.buffered += chunk;

    // Detect on the full buffer
    const leaks = detectLeaks(this.buffered);

    if (leaks.length > 0) {
      const redacted = redactLeaks(this.buffered);
      // Keep only the overlap tail for the next feed
      this.buffered = redacted.slice(-StreamingLeakBuffer.OVERLAP);
      const safe = redacted.slice(0, -StreamingLeakBuffer.OVERLAP || undefined);
      return { safe, leaks };
    }

    // No leaks — emit everything except the overlap tail
    if (this.buffered.length > StreamingLeakBuffer.OVERLAP) {
      const safe = this.buffered.slice(0, -StreamingLeakBuffer.OVERLAP);
      this.buffered = this.buffered.slice(-StreamingLeakBuffer.OVERLAP);
      return { safe, leaks: [] };
    }

    // Buffer is still within overlap window — hold it
    return { safe: "", leaks: [] };
  }

  /** Flush any remaining buffered text at end-of-stream. */
  flush(): { safe: string; leaks: LeakDetection[] } {
    const leaks = detectLeaks(this.buffered);
    const safe = leaks.length > 0 ? redactLeaks(this.buffered) : this.buffered;
    this.buffered = "";
    return { safe, leaks };
  }
}
