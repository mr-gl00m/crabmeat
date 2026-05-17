import { describe, it, expect, beforeEach } from "vitest";
import {
  mintCanaryToken,
  getCanaryToken,
  isCanary,
  buildCanaryPattern,
  revokeCanary,
  clearCanaries,
} from "./canary.js";

beforeEach(() => {
  clearCanaries();
});

describe("mintCanaryToken", () => {
  it("returns a string starting with CLWM_CANARY_", () => {
    const token = mintCanaryToken("session-1");
    expect(token).toMatch(/^CLWM_CANARY_[a-f0-9]{32}$/);
  });

  it("returns the same token for the same session key", () => {
    const a = mintCanaryToken("session-1");
    const b = mintCanaryToken("session-1");
    expect(a).toBe(b);
  });

  it("returns different tokens for different session keys", () => {
    const a = mintCanaryToken("session-1");
    const b = mintCanaryToken("session-2");
    expect(a).not.toBe(b);
  });
});

describe("getCanaryToken", () => {
  it("returns undefined when no canary has been minted", () => {
    expect(getCanaryToken("unknown")).toBeUndefined();
  });

  it("returns the minted canary", () => {
    const token = mintCanaryToken("sess-x");
    expect(getCanaryToken("sess-x")).toBe(token);
  });
});

describe("isCanary", () => {
  it("detects text containing a canary prefix", () => {
    const token = mintCanaryToken("sess");
    expect(isCanary(`The model said ${token} in output`)).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isCanary("Just a normal response")).toBe(false);
  });
});

describe("buildCanaryPattern", () => {
  it("returns undefined when no canary exists", () => {
    expect(buildCanaryPattern("nope")).toBeUndefined();
  });

  it("produces a regex that matches the minted canary", () => {
    const token = mintCanaryToken("sess-1");
    const pattern = buildCanaryPattern("sess-1");
    expect(pattern).toBeDefined();
    expect(pattern!.test(token)).toBe(true);
  });

  it("does not match a different session's canary", () => {
    mintCanaryToken("sess-1");
    const token2 = mintCanaryToken("sess-2");
    const pattern1 = buildCanaryPattern("sess-1");
    expect(pattern1!.test(token2)).toBe(false);
  });
});

describe("revokeCanary", () => {
  it("removes the canary for a session", () => {
    mintCanaryToken("sess");
    revokeCanary("sess");
    expect(getCanaryToken("sess")).toBeUndefined();
  });
});
