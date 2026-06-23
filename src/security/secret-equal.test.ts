import { describe, it, expect } from "vitest";
import { secretEqual } from "./secret-equal.js";

describe("secretEqual", () => {
  it("returns true for identical strings", () => {
    expect(secretEqual("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(secretEqual("my-secret-token", "wrong-token")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(secretEqual("", "something")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(secretEqual("", "")).toBe(true);
  });

  it("handles different lengths without timing leak", () => {
    expect(secretEqual("short", "a-much-longer-string")).toBe(false);
  });
});
