import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { registerBuiltinTools } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";

beforeAll(() => {
  registerBuiltinTools();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchResponse(body: string, ok = true, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    }) as unknown as Response,
  );
}

describe("weather tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("weather")).toBe(true);
  });

  it("returns trimmed plain-text report on success", async () => {
    mockFetchResponse("Tokyo: 🌦 +22°C\n");
    const handler = getToolHandler("weather");
    const res = await handler({ location: "Tokyo" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("Tokyo: 🌦 +22°C");
    expect(res.outputs?.location).toBe("Tokyo");
    expect(res.outputs?.report).toBe("Tokyo: 🌦 +22°C");
    expect(res.outputs?.format).toBe("3");
  });

  it("passes through custom format strings", async () => {
    mockFetchResponse("Paris: 🌤 +15°C 💨10km/h");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Paris: 🌤 +15°C 💨10km/h", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }) as unknown as Response,
    );
    const handler = getToolHandler("weather");
    await handler({ location: "Paris", format: "4" });
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("wttr.in/Paris");
    expect(calledUrl).toContain("format=4");
  });

  it("URL-encodes spaces and special chars in location", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("New York: ⛅ +12°C", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }) as unknown as Response,
    );
    const handler = getToolHandler("weather");
    await handler({ location: "New York" });
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("wttr.in/New+York");
  });

  it("surfaces HTML error pages as unresolvable location", async () => {
    mockFetchResponse("<!DOCTYPE html><html><body>Unknown location</body></html>");
    const handler = getToolHandler("weather");
    const res = await handler({ location: "ZZZZ-not-a-place" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Could not resolve");
  });

  it("returns error on non-2xx HTTP response", async () => {
    mockFetchResponse("", false, 503);
    const handler = getToolHandler("weather");
    const res = await handler({ location: "Berlin" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 503");
  });

  it("returns error when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const handler = getToolHandler("weather");
    const res = await handler({ location: "Dublin" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Weather lookup error");
  });
});
