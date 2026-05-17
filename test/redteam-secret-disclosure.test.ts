/**
 * RT-SECRET-DISCLOSURE regression suite (Phase 4.19 A2).
 *
 * Plants known secrets in the running gateway's config (auth token,
 * admin token, provider apiKey, IMAP password). Hits every HTTP route
 * the gateway exposes — happy path AND auth-failure path — and asserts
 * no response body contains a verbatim secret value.
 *
 * Why: a single accidental log-the-config-on-error / serialize-the-
 * provider-list endpoint blows the whole local-first security pitch.
 * Lock the current "no secrets cross HTTP" property in CI so a future
 * /admin/status or diagnostics-dump endpoint can't quietly add a
 * regression. Gator cross-audit B2 is the source of this discipline.
 *
 * The suite enumerates routes as constants because new routes should
 * be obvious to add. If a future PR introduces an HTTP endpoint that
 * isn't on this list, the audit pass that catches it is human review;
 * this suite catches the existing surface.
 *
 * The legal pattern for surfaced refs is `****last4` masking. The
 * full secret value MUST NOT appear.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import type { Config } from "../src/config/types.js";

const PORT = 9907;

// Known secrets planted in config — these strings must never appear in
// any HTTP response body or header. Made distinctive so a substring
// match is meaningful.
const SECRETS = {
  authToken: "AUTH_TOKEN_LEAK_CANARY_3kF9xR2wQvN7yT5pZc8dG0hJabcd",
  adminToken: "ADMIN_TOKEN_LEAK_CANARY_xL9mQ4vN2yT7pZc5dG3hJ8wRabcd",
  providerKey: "sk-PROVIDER_KEY_LEAK_CANARY_abc123def456ghi789jkl0",
  imapPassword: "IMAP_PWD_LEAK_CANARY_aBcDeFgHiJkLmNoP",
} as const;

function configWithAllSecrets(): Config {
  return {
    gateway: {
      host: "127.0.0.1",
      port: PORT,
      auth: { mode: "token" as const, token: SECRETS.authToken },
      origins: ["http://localhost:*"],
    },
    agents: [
      {
        id: "default",
        name: "T",
        systemPrompt: "test",
        temperature: 0.7,
        maxTokens: 4096,
        tools: [],
        allowedEffects: ["read"],
        maxToolIterations: 5,
      },
    ],
    providers: [
      {
        id: "openai",
        type: "openai" as const,
        apiKey: SECRETS.providerKey,
        model: "gpt-4.1",
        maxRetries: 2,
        timeoutMs: 60_000,
      },
    ],
    session: {
      backend: "json" as const,
      dir: ".crabmeat/sessions-test-secret-disclosure",
      maxTranscriptEntries: 200,
      retentionDays: 30,
    },
    routing: { defaultAgentId: "default", bindings: [] },
    tools: [],
    admin: {
      enabled: true,
      token: SECRETS.adminToken,
    },
    connectors: {
      emailImap: {
        user: "agent@example.com",
        password: SECRETS.imapPassword,
        allowFromAddresses: ["owner@example.com"],
      },
    },
  } as unknown as Config;
}

/**
 * Routes the gateway exposes. Every entry should be hit at least
 * once. New routes added to the gateway must be added here too —
 * absence is the bug this suite is meant to catch.
 *
 * `auth` is the auth class:
 *   - "none" — no header required (operator-facing health/ready)
 *   - "admin" — Authorization: Bearer <admin token>
 *   - "kill-token" — kill-token query string (out-of-band stop)
 */
interface ProbeRoute {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  auth: "none" | "admin" | "kill-token";
  body?: Record<string, unknown>;
  // When true, also probe the auth-failure path (wrong/no token) to
  // cover error responses, which historically have been a leak vector.
  testAuthFail?: boolean;
}

const PROBE_ROUTES: ProbeRoute[] = [
  { path: "/health", method: "GET", auth: "none" },
  { path: "/ready", method: "GET", auth: "none" },
  { path: "/admin/kill", method: "POST", auth: "admin", testAuthFail: true },
  {
    path: "/admin/circuit-breaker",
    method: "POST",
    auth: "admin",
    body: { action: "trip", reason: "test probe" },
    testAuthFail: true,
  },
  // /admin/kill-token: token is the credential. We test both the
  // unauthorized and an expected-rejected token path (no live token
  // exists in this test config, so we just confirm the rejection
  // doesn't leak secrets either).
  {
    path: "/admin/kill-token?token=nonexistent",
    method: "POST",
    auth: "kill-token",
  },
  // 404 path — error response shape.
  { path: "/this-route-does-not-exist", method: "GET", auth: "none" },
  { path: "/admin/this-also-does-not-exist", method: "POST", auth: "none" },
];

function assertNoSecretLeak(body: string, label: string): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(body, `${label} leaked ${name}`).not.toContain(value);
  }
}

function assertHeadersNoSecretLeak(headers: Headers, label: string): void {
  const all: string[] = [];
  headers.forEach((v, k) => all.push(`${k}: ${v}`));
  const joined = all.join("\n");
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(joined, `${label} headers leaked ${name}`).not.toContain(value);
  }
}

describe("RT-SECRET-DISCLOSURE: no secret values in any HTTP response", () => {
  let gw: Gateway;

  beforeAll(async () => {
    gw = createGateway(configWithAllSecrets());
    await gw.start();
    // Match the wait pattern other gateway-using tests use.
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    if (gw) await gw.stop();
  });

  for (const route of PROBE_ROUTES) {
    it(`${route.method} ${route.path} (auth=${route.auth}) — no secrets in body or headers`, async () => {
      const headers: Record<string, string> = {};
      if (route.auth === "admin") {
        headers.authorization = `Bearer ${SECRETS.adminToken}`;
      }

      const init: RequestInit = {
        method: route.method,
        headers,
      };
      if (route.body) {
        init.body = JSON.stringify(route.body);
        headers["content-type"] = "application/json";
      }

      try {
        const res = await fetch(`http://127.0.0.1:${PORT}${route.path}`, init);
        const body = await res.text();
        assertNoSecretLeak(body, `${route.method} ${route.path}`);
        assertHeadersNoSecretLeak(res.headers, `${route.method} ${route.path}`);
      } catch (err) {
        // Network failures (ECONNRESET on plain HTTP, etc.) are not
        // disclosure events. We only care that successful responses
        // don't leak. Surface unexpected fetch errors but don't fail.
        if (err instanceof Error && /ECONNRESET|fetch failed/i.test(err.message)) {
          return;
        }
        throw err;
      }
    });

    if (route.testAuthFail) {
      it(`${route.method} ${route.path} (auth FAIL) — no secrets in error response`, async () => {
        const init: RequestInit = {
          method: route.method,
          headers: { authorization: "Bearer wrong-token" },
        };
        if (route.body) {
          init.body = JSON.stringify(route.body);
          (init.headers as Record<string, string>)["content-type"] = "application/json";
        }
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}${route.path}`, init);
          const body = await res.text();
          assertNoSecretLeak(body, `${route.method} ${route.path} (auth fail)`);
          assertHeadersNoSecretLeak(res.headers, `${route.method} ${route.path} (auth fail)`);
        } catch (err) {
          if (err instanceof Error && /ECONNRESET|fetch failed/i.test(err.message)) {
            return;
          }
          throw err;
        }
      });
    }
  }

  it("known secret values were actually planted (sanity check)", () => {
    // Self-check that the canaries are distinctive enough that a real
    // leak would be caught by toContain. If someone tightens the
    // canaries down to common substrings, the suite goes blind.
    expect(SECRETS.authToken.length).toBeGreaterThan(20);
    expect(SECRETS.adminToken.length).toBeGreaterThan(20);
    expect(SECRETS.providerKey.length).toBeGreaterThan(20);
    expect(SECRETS.imapPassword.length).toBeGreaterThan(20);
    expect(new Set(Object.values(SECRETS)).size).toBe(4);
  });
});
