// Regression test for BH-2026-05-10-007 (bug-hunt 2026-05-10).
// Invariant: web_fetch claims SSRF protection via isSafeBaseUrl. The
// original code ran the check once on the initial URL but passed
// redirect:"follow" to fetch, so any 302 to a private host bypassed the
// guard and surfaced the body verbatim.
// Fix: re-check response.url with isSafeBaseUrl after the fetch returns;
// bail with an SSRF error if the final hop is a private/metadata/loopback
// host.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  registerBuiltinTools,
  setWorkspaceRoot,
} from "../src/agents/tools/builtins.js";
import { getToolHandler } from "../src/agents/tools/handlers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BH-2026-05-10-007: web_fetch must re-validate after HTTP redirect", () => {
  beforeAll(() => {
    setWorkspaceRoot(mkdtempSync(join(tmpdir(), "bh-webfetch-")));
    registerBuiltinTools({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a redirect from a public URL to 169.254.169.254 is blocked or surfaced as error", async () => {
    const metadataUrl = "http://169.254.169.254/latest/meta-data/iam/";
    const stubFetch = vi.fn(async (input: string | URL | Request) => {
      void input;
      return new Response("AWS_INSTANCE_PROFILE_KEY=AKIA...", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }) as unknown as Response & { url: string };
    });
    const wrapped = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const r = await stubFetch(input);
      Object.defineProperty(r, "url", { value: metadataUrl, configurable: true });
      void init;
      return r;
    });
    vi.stubGlobal("fetch", wrapped);

    const fetchHandler = getToolHandler("web_fetch");
    const result = await fetchHandler({ url: "https://safe-public.example.com/page" });

    expect(
      result.isError === true ||
        /SSRF|metadata|blocked|169\.254/i.test(result.content),
      "web_fetch returned a non-error response after a redirect to 169.254.169.254. " +
        "It surfaced finalUrl=" +
        JSON.stringify(result.outputs?.url) +
        " and content head: " +
        JSON.stringify(result.content.slice(0, 100)) +
        ". Expected an SSRF block or warning citing the post-redirect URL.",
    ).toBe(true);
  });

  it("a redirect to 127.0.0.1 is blocked or surfaced as error", async () => {
    const localUrl = "http://127.0.0.1:8080/admin";
    const wrapped = vi.fn(async (_input: string | URL | Request) => {
      const r = new Response("admin panel", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(r, "url", { value: localUrl, configurable: true });
      return r;
    });
    vi.stubGlobal("fetch", wrapped);

    const fetchHandler = getToolHandler("web_fetch");
    const result = await fetchHandler({ url: "https://safe-public.example.com/page" });

    expect(
      result.isError === true ||
        /SSRF|127\.0\.0\.1|blocked|loopback/i.test(result.content),
      "web_fetch returned a non-error after redirect to 127.0.0.1; finalUrl=" +
        JSON.stringify(result.outputs?.url),
    ).toBe(true);
  });
});
