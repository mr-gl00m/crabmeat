/**
 * RT-WEB-FETCH SSRF regression suite (Phase 4.19 A1).
 *
 * `web_fetch` is the highest-blast-radius network tool — an LLM-controlled
 * GET against an arbitrary URL. Without strict SSRF protection it becomes
 * a credential-leak vector for cloud-metadata services, an internal-network
 * scanner, and a vehicle for prompt injection from local services that
 * speak HTTP. The Gator cross-audit (2026-05-06) flagged the missing
 * regression suite as a ship blocker; this file is that suite.
 *
 * Failures here are ship blockers. Locking the current SSRF posture so
 * future refactors can't silently widen the attack surface is the
 * point.
 *
 * Coverage groups:
 *   - Loopback (IPv4 + IPv6, with port + path variations)
 *   - Link-local (AWS metadata, GCP metadata, Azure IMDS, generic 169.254)
 *   - RFC1918 (10/8, 172.16-31/12, 192.168/16)
 *   - IPv6 unique-local (fd00::/8, ULA — currently a known gap)
 *   - Scheme bypasses (file:, gopher:, data:, javascript:)
 *   - 0.0.0.0 (wildcard bind)
 *   - DNS rebinding (parser-level vs resolver-level — known gap)
 *
 * Tests use `isSafeBaseUrl` directly because it's the gate every
 * URL-accepting code path runs through (provider baseUrl, web_fetch,
 * web_search backends). If the gate holds, downstream callers hold.
 */

import { describe, it, expect } from "vitest";
import { isSafeBaseUrl } from "../src/config/schema.js";

// Default behavior: allowLocal=false (the production posture). When the
// operator opts into local providers (Ollama on 127.0.0.1) they pass
// allowLocal=true to *that specific check site* — the SSRF-protected
// web_fetch call always passes false.
const blocked = (url: string) => isSafeBaseUrl(url, false) === false;
const allowed = (url: string) => isSafeBaseUrl(url, false) === true;

describe("RT-WEB-FETCH SSRF: loopback IPv4", () => {
  it("blocks bare 127.0.0.1", () => {
    expect(blocked("http://127.0.0.1/admin")).toBe(true);
    expect(blocked("https://127.0.0.1:8080/")).toBe(true);
  });

  it("blocks the literal hostname 'localhost'", () => {
    expect(blocked("http://localhost/")).toBe(true);
    expect(blocked("http://localhost:11434/api/tags")).toBe(true);
  });

  it("allows 127.x.x.x loopback range when allowLocal=true (Ollama path)", () => {
    expect(isSafeBaseUrl("http://127.0.0.1:11434", true)).toBe(true);
    expect(isSafeBaseUrl("http://localhost:1234", true)).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: loopback IPv6", () => {
  it("blocks bare [::1]", () => {
    expect(blocked("http://[::1]/")).toBe(true);
    expect(blocked("http://[::1]:8080/admin")).toBe(true);
  });

  it("allows [::1] when allowLocal=true (parity with IPv4 path)", () => {
    expect(isSafeBaseUrl("http://[::1]:11434", true)).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: link-local + cloud metadata", () => {
  it("blocks AWS instance metadata service (169.254.169.254)", () => {
    expect(blocked("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(blocked("http://169.254.169.254/latest/api/token")).toBe(true);
  });

  it("blocks GCP metadata server (metadata.google.internal)", () => {
    expect(blocked("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
  });

  it("blocks any 169.254.0.0/16 link-local (Azure IMDS lives at 169.254.169.254 too)", () => {
    expect(blocked("http://169.254.1.1/")).toBe(true);
    expect(blocked("http://169.254.99.99/")).toBe(true);
    expect(blocked("https://169.254.169.254/metadata/identity/oauth2/token")).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: RFC1918 private ranges", () => {
  it("blocks 10.0.0.0/8", () => {
    expect(blocked("http://10.0.0.1/")).toBe(true);
    expect(blocked("http://10.255.255.255/")).toBe(true);
    expect(blocked("https://10.42.0.7:8080/internal")).toBe(true);
  });

  it("blocks 192.168.0.0/16", () => {
    expect(blocked("http://192.168.0.1/")).toBe(true);
    expect(blocked("http://192.168.1.100/router/admin")).toBe(true);
    expect(blocked("https://192.168.255.255/")).toBe(true);
  });

  it("blocks 172.16.0.0/12 (172.16 through 172.31)", () => {
    expect(blocked("http://172.16.0.1/")).toBe(true);
    expect(blocked("http://172.20.10.5/")).toBe(true);
    expect(blocked("https://172.31.255.255/")).toBe(true);
  });

  it("does NOT block 172.x outside the /12 (172.0-15 and 172.32-255)", () => {
    // These are public IPs and should pass.
    expect(allowed("https://172.15.0.1/")).toBe(true);
    expect(allowed("https://172.32.0.1/")).toBe(true);
  });

  it("blocks 0.0.0.0 (wildcard bind, not a routable target)", () => {
    expect(blocked("http://0.0.0.0/")).toBe(true);
    expect(blocked("http://0.0.0.0:8080/")).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: scheme bypasses", () => {
  it("blocks file:// (local filesystem read)", () => {
    expect(blocked("file:///etc/passwd")).toBe(true);
    expect(blocked("file://localhost/etc/shadow")).toBe(true);
  });

  it("blocks gopher:// (used in classic SSRF chain attacks)", () => {
    expect(blocked("gopher://attacker.example.com:70/")).toBe(true);
  });

  it("blocks data: (inline payload, not a real fetch but blocks confusion)", () => {
    expect(blocked("data:text/html,<script>alert(1)</script>")).toBe(true);
  });

  it("blocks javascript:", () => {
    expect(blocked("javascript:fetch('http://attacker.com')")).toBe(true);
  });

  it("blocks ftp://", () => {
    expect(blocked("ftp://internal.example.com/secrets.txt")).toBe(true);
  });

  it("allows http:// to a public host", () => {
    expect(allowed("http://example.com/")).toBe(true);
  });

  it("allows https:// to a public host", () => {
    expect(allowed("https://example.com/path?query=1")).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: malformed input", () => {
  it("blocks an empty / whitespace URL", () => {
    expect(blocked("")).toBe(true);
    expect(blocked("   ")).toBe(true);
  });

  it("blocks a URL with no host", () => {
    // `http://` throws in the WHATWG URL parser → caught → blocked.
    expect(blocked("http://")).toBe(true);
    // Note: `https:///path` parses with hostname="path" (WHATWG URL
    // treats the first segment as the host when the authority is
    // empty). That's a legal — if weird — hostname, not an SSRF
    // concern. We don't try to second-guess single-word hostnames.
  });

  it("blocks a malformed URL", () => {
    expect(blocked("not a url at all")).toBe(true);
    expect(blocked("http://[fe80::]:invalid")).toBe(true);
  });
});

describe("RT-WEB-FETCH SSRF: known gaps (should fail or it.todo)", () => {
  // IPv6 unique-local addresses (fd00::/8) are the IPv6 equivalent of
  // RFC1918. The current isSafeBaseUrl does not check IPv6 ranges
  // beyond the explicit [::1] loopback. Operators on IPv6-only LANs
  // could expose internal services this way. Failing this test is the
  // signal to extend the IPv6 check.
  it("BLOCKED-AS-OF-2026-05-09: IPv6 unique-local (fd00::/8 ULA)", () => {
    expect(blocked("http://[fd00::1]/")).toBe(true);
    expect(blocked("http://[fdab:cd::1]:8080/admin")).toBe(true);
    expect(blocked("https://[fc00::1]/")).toBe(true);
  });

  it("BLOCKED-AS-OF-2026-05-09: IPv6 link-local (fe80::/10)", () => {
    expect(blocked("http://[fe80::1]/")).toBe(true);
    expect(blocked("http://[fe80::abcd]:8080/")).toBe(true);
  });

  it("BLOCKED-AS-OF-2026-05-09: IPv4-mapped IPv6 loopback ([::ffff:127.0.0.1])", () => {
    expect(blocked("http://[::ffff:127.0.0.1]/")).toBe(true);
    expect(blocked("http://[::ffff:7f00:1]/")).toBe(true);
  });

  it.todo(
    "DNS rebinding: a hostname that resolves to a private IP at fetch time bypasses the parser-level check. Mitigation: do the DNS resolution and re-check the resolved address before fetch. Not yet implemented.",
  );
});
