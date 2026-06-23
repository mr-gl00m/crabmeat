import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "./origin.js";

describe("isOriginAllowed", () => {
  const allowlist = ["http://localhost:*", "https://myapp.example.com"];

  it("allows undefined origin (non-browser client)", () => {
    expect(isOriginAllowed(undefined, allowlist)).toBe(true);
  });

  it("allows exact match", () => {
    expect(isOriginAllowed("https://myapp.example.com", allowlist)).toBe(true);
  });

  it("allows wildcard port match", () => {
    expect(isOriginAllowed("http://localhost:3000", allowlist)).toBe(true);
    expect(isOriginAllowed("http://localhost:8080", allowlist)).toBe(true);
  });

  it("allows localhost without port when wildcard port is set", () => {
    expect(isOriginAllowed("http://localhost", allowlist)).toBe(true);
  });

  it("rejects unknown origins", () => {
    expect(isOriginAllowed("https://evil.com", allowlist)).toBe(false);
  });

  it("rejects partial matches", () => {
    expect(isOriginAllowed("https://myapp.example.com.evil.com", allowlist)).toBe(false);
  });

  it("does NOT fall back to Host header (no CSWSH bypass)", () => {
    // There is no Host header fallback. This test documents that
    // the function only accepts explicit origin values.
    expect(isOriginAllowed("https://evil.com", allowlist)).toBe(false);
  });
});
