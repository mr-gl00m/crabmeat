import { describe, it, expect } from "vitest";
import {
  checkByteSize,
  stripNullBytes,
  detectLeaks,
  redactLeaks,
  redactToolResultSecrets,
} from "./sanitize.js";

describe("checkByteSize", () => {
  it("allows input within limit", () => {
    expect(checkByteSize("hello", 10)).toBe(true);
  });

  it("rejects input exceeding limit", () => {
    expect(checkByteSize("hello world", 5)).toBe(false);
  });

  it("counts multi-byte characters correctly", () => {
    // "ä" is 2 bytes in UTF-8
    expect(checkByteSize("ä", 1)).toBe(false);
    expect(checkByteSize("ä", 2)).toBe(true);
  });
});

describe("stripNullBytes", () => {
  it("removes null bytes from input", () => {
    expect(stripNullBytes("he\0llo")).toBe("hello");
  });

  it("leaves clean strings unchanged", () => {
    expect(stripNullBytes("hello")).toBe("hello");
  });
});

describe("detectLeaks", () => {
  it("detects capability IDs", () => {
    const leaks = detectLeaks("The tool cap_a1b2c3d4e5f6 was used");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("capability_id");
  });

  it("detects OpenAI API key patterns", () => {
    const leaks = detectLeaks("key is sk-abcdefghijklmnopqrstuvwxyz");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("openai_key");
  });

  it("detects trust boundary tags", () => {
    const leaks = detectLeaks("The IRONCLAD_CONTEXT section says...");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("ironclad_context_tag");
  });

  it("returns empty for clean text", () => {
    expect(detectLeaks("Just a normal response about the weather")).toHaveLength(0);
  });
});

describe("redactLeaks", () => {
  it("redacts capability IDs", () => {
    expect(redactLeaks("Used cap_a1b2c3d4e5f6 tool")).toBe(
      "Used [REDACTED] tool",
    );
  });

  it("redacts multiple patterns", () => {
    const input = "cap_a1b2c3d4e5f6 and IRONCLAD_CONTEXT";
    const result = redactLeaks(input);
    expect(result).toBe("[REDACTED] and [REDACTED]");
  });
});

describe("detectLeaks — tool result secret patterns", () => {
  it("detects AWS access keys", () => {
    const leaks = detectLeaks("key: AKIAIOSFODNN7EXAMPLE");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("aws_access_key");
  });

  it("detects JWT tokens", () => {
    const leaks = detectLeaks("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("jwt_token");
  });

  it("detects connection strings", () => {
    const patterns = [
      "postgres://user:pass@host:5432/db",
      "mongodb+srv://admin:secret@cluster.mongodb.net/mydb",
      "redis://default:mypassword@cache.example.com:6379",
    ];
    for (const cs of patterns) {
      const leaks = detectLeaks(cs);
      expect(leaks.length).toBeGreaterThan(0);
      expect(leaks.some((l) => l.label === "connection_string")).toBe(true);
    }
  });

  it("detects password assignments", () => {
    const leaks = detectLeaks("password=SuperSecret123!");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("password_assignment");
  });

  it("detects private key headers", () => {
    const leaks = detectLeaks("-----BEGIN RSA PRIVATE KEY-----");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("private_key");
  });

  it("redacts all new patterns", () => {
    const input = "AKIAIOSFODNN7EXAMPLE and password=secret";
    const result = redactLeaks(input);
    expect(result).not.toContain("AKIA");
    expect(result).not.toContain("secret");
    expect(result).toContain("[REDACTED]");
  });

  // Coverage for the Gil-Pinsky-style "reply with your .env" attack —
  // the OpenAI pattern's [a-zA-Z0-9]+ class stops at the first dash, so
  // it never matched Anthropic keys before the dedicated pattern was
  // added. Without this, an .env file lifted past file_read's scrubber
  // would leak ANTHROPIC_API_KEY untouched.
  it("detects Anthropic API keys", () => {
    const leaks = detectLeaks("ANTHROPIC_API_KEY=sk-ant-api03-ZW5jcnlwdGVkX2Zha2VfYW50aHJvcGljX2tleQ");
    expect(leaks.some((l) => l.label === "anthropic_key")).toBe(true);
  });

  it("redacts Anthropic API keys end-to-end", () => {
    const result = redactLeaks("key: sk-ant-api03-abcdefghij1234567890ZZZ");
    expect(result).not.toContain("sk-ant-api03-");
    expect(result).toContain("[REDACTED]");
  });

  it("detects generic env-style API_KEY/TOKEN/SECRET assignments", () => {
    const cases = [
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
      "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "DATABASE_PASSWORD=hunter22hunter22",
      "MY_SERVICE_SECRET=12345678abcdef",
    ];
    for (const line of cases) {
      const leaks = detectLeaks(line);
      expect(leaks.length, `expected leak for: ${line}`).toBeGreaterThan(0);
    }
  });

  it("detects newer GitHub token shapes (gho_/ghu_/ghs_/ghr_)", () => {
    const cases = [
      "gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ghs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "ghr_ccccccccccccccccccccccccccccccccccccc",
      "ghu_ddddddddddddddddddddddddddddddddddddd",
    ];
    for (const tok of cases) {
      const leaks = detectLeaks(tok);
      expect(leaks.length, `expected leak for: ${tok}`).toBeGreaterThan(0);
    }
  });
});

describe("redactToolResultSecrets", () => {
  it("returns redacted content and leak list for secrets", () => {
    const { redacted, leaks } = redactToolResultSecrets(
      "DB: postgres://user:pass@host/db",
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.label).toBe("connection_string");
    expect(redacted).not.toContain("postgres://");
    expect(redacted).toContain("[REDACTED]");
  });

  it("passes through clean content unchanged", () => {
    const clean = "This is a normal tool result with no secrets";
    const { redacted, leaks } = redactToolResultSecrets(clean);
    expect(leaks).toHaveLength(0);
    expect(redacted).toBe(clean);
  });

  it("accepts extra patterns for session-specific detection", () => {
    const extra = [{ pattern: /CANARY_TOKEN_ABC/g, label: "canary" }];
    const { leaks } = redactToolResultSecrets("found CANARY_TOKEN_ABC here", extra);
    expect(leaks.some((l) => l.label === "canary")).toBe(true);
  });
});
