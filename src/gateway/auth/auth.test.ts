import { describe, it, expect } from "vitest";
import { authenticate } from "./auth.js";
import type { GatewayConfig } from "../../config/types.js";

function makeConfig(
  overrides: Partial<GatewayConfig["auth"]> & { mode: GatewayConfig["auth"]["mode"] },
): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    auth: overrides,
    origins: [],
  };
}

describe("authenticate", () => {
  it("passes with mode=none", () => {
    const config = makeConfig({ mode: "none" });
    const result = authenticate(config, {});
    expect(result.authenticated).toBe(true);
  });

  it("passes with correct token", () => {
    const config = makeConfig({ mode: "token", token: "secret-123" });
    const result = authenticate(config, { token: "secret-123" });
    expect(result.authenticated).toBe(true);
  });

  it("fails with wrong token", () => {
    const config = makeConfig({ mode: "token", token: "secret-123" });
    const result = authenticate(config, { token: "wrong" });
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("Invalid token");
  });

  it("fails with missing token", () => {
    const config = makeConfig({ mode: "token", token: "secret-123" });
    const result = authenticate(config, {});
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("Token required");
  });

  it("passes with correct password", () => {
    const config = makeConfig({ mode: "password", password: "pass-456" });
    const result = authenticate(config, { password: "pass-456" });
    expect(result.authenticated).toBe(true);
  });

  it("fails with wrong password", () => {
    const config = makeConfig({ mode: "password", password: "pass-456" });
    const result = authenticate(config, { password: "wrong" });
    expect(result.authenticated).toBe(false);
  });
});
