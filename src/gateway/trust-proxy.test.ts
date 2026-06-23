/**
 * RT-2026-04-30-008 — pre-upgrade rate limiter must derive the client IP
 * from X-Forwarded-For when trustProxy is enabled, so the limiter doesn't
 * collapse to one bucket behind a reverse proxy.
 */

import { describe, it, expect } from "vitest";
import { clientIpForRateLimit } from "./server.js";

interface FakeReq {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

function makeReq(opts: FakeReq): FakeReq {
  return opts;
}

describe("clientIpForRateLimit", () => {
  it("falls back to socket address when trustProxy is false (default)", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(clientIpForRateLimit(req, false)).toBe("10.0.0.1");
  });

  it("uses rightmost non-private XFF hop when trustProxy is true", () => {
    // Single proxy in front: XFF = "real-client, proxy". Rightmost
    // non-private hop is the real client.
    const req = makeReq({
      headers: { "x-forwarded-for": "203.0.113.42, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(clientIpForRateLimit(req, true)).toBe("203.0.113.42");
  });

  it("walks past multiple private hops to find the real client", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1, 192.168.1.1, 127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    expect(clientIpForRateLimit(req, true)).toBe("198.51.100.9");
  });

  it("falls back to socket address when XFF is all-private", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "10.0.0.5, 192.168.1.7" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    expect(clientIpForRateLimit(req, true)).toBe("127.0.0.1");
  });

  it("ignores XFF entirely when trustProxy is false (no spoofing via header)", () => {
    // Attacker sends X-Forwarded-For: 1.2.3.4 hoping to share a victim's
    // bucket. Without trustProxy, we MUST ignore that and key on the
    // real socket address (which is the attacker's).
    const req = makeReq({
      headers: { "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "9.9.9.9" },
    });
    expect(clientIpForRateLimit(req, false)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no socket address is available", () => {
    const req = makeReq({});
    expect(clientIpForRateLimit(req, false)).toBe("unknown");
  });

  it("handles IPv6 link-local and loopback as private", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "2001:db8::1, fe80::1, ::1" },
      socket: { remoteAddress: "::1" },
    });
    expect(clientIpForRateLimit(req, true)).toBe("2001:db8::1");
  });
});
