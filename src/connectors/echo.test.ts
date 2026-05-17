import { describe, it, expect } from "vitest";
import { createEchoConnector } from "./echo.js";

describe("echo connector", () => {
  it("has the expected shape", () => {
    const c = createEchoConnector();
    expect(c.id).toBe("echo");
    expect(c.name).toBe("echo");
    expect(c.trustLevel).toBe("standard");
  });

  it("accepts a custom id", () => {
    const c = createEchoConnector({ id: "loopback" });
    expect(c.id).toBe("loopback");
  });

  it("delivery always succeeds and returns ok", async () => {
    const c = createEchoConnector();
    const res = await c.deliver({
      sessionKey: "s1",
      content: "hello",
      killUrl: "https://example.test/admin/kill-token?t=abc",
      reason: "testing",
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("handles empty fields without throwing", async () => {
    const c = createEchoConnector();
    const res = await c.deliver({
      sessionKey: "s1",
      content: "",
      killUrl: "",
      reason: "",
    });
    expect(res.ok).toBe(true);
  });
});
