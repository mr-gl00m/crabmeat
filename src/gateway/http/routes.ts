import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealth, handleReadiness } from "./health.js";
import { withDefaults } from "./middleware.js";
import { setSecurityHeaders } from "../../security/headers.js";
import { handleAdminKill, handleCircuitBreaker, handleKillToken, type AdminContext } from "./admin.js";
import { handleGreenlight, type GreenlightContext } from "./greenlight.js";
import type { Config, WebhookConfig } from "../../config/types.js";
import type { Gateway } from "../server.js";
import { createWebhookHandler } from "../../scheduler/webhook.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function createRouteHandler(
  config: Config,
  getGateway: () => Gateway,
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Record<string, RouteHandler> = {
    "/health": withDefaults(handleHealth),
    "/ready": withDefaults(handleReadiness),
  };

  // Greenlight composite go/no-go (Phase 4.19 B1). Auth-gated when
  // an admin token is configured (it leaks operational state about
  // providers + circuit-breaker that is more useful to attackers than
  // /health). When admin auth is disabled (dev mode) the endpoint is
  // open for the same reason /health is — operator wants to read it
  // without setting up auth on day one.
  const greenlightCtx: GreenlightContext = {
    adminToken: config.admin?.enabled && config.admin?.token ? config.admin.token : null,
    config,
    get circuitBreaker() {
      return getGateway().circuitBreaker;
    },
    get providers() {
      return getGateway().pipeline;
    },
  };
  routes["/greenlight"] = withDefaults(handleGreenlight(greenlightCtx));

  // Kill-token endpoint is always available — the token is the credential.
  // This is the out-of-band emergency stop embedded in outbound messages.
  const killTokenCtx: AdminContext = {
    // Kill-token handler doesn't use adminToken or shutdownFn; only the
    // circuit breaker and audit log getters are accessed. We still
    // satisfy the interface.
    adminToken: "",
    get circuitBreaker() {
      return getGateway().circuitBreaker;
    },
    get auditLog() {
      return getGateway().auditLog;
    },
    shutdownFn: async () => {
      await getGateway().stop();
    },
  };
  routes["/admin/kill-token"] = withDefaults(handleKillToken(killTokenCtx));

  // Register authenticated admin endpoints only when enabled + token is set
  if (config.admin?.enabled && config.admin?.token) {
    const adminCtx: AdminContext = {
      adminToken: config.admin.token,
      get circuitBreaker() {
        return getGateway().circuitBreaker;
      },
      get auditLog() {
        return getGateway().auditLog;
      },
      shutdownFn: async () => {
        await getGateway().stop();
      },
    };

    routes["/admin/kill"] = withDefaults(handleAdminKill(adminCtx));
    routes["/admin/circuit-breaker"] = withDefaults(handleCircuitBreaker(adminCtx));
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    let pathname: string;
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      pathname = url.pathname;
    } catch {
      setSecurityHeaders(res);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid URL" }));
      return;
    }

    const handler = routes[pathname];

    if (handler) {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) {
          setSecurityHeaders(res);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Internal error" }));
        }
      });
      return;
    }

    // Webhook prefix match
    const webhookConfig = config.webhooks as WebhookConfig | undefined;
    if (webhookConfig?.enabled) {
      const basePath = webhookConfig.basePath.endsWith("/")
        ? webhookConfig.basePath
        : webhookConfig.basePath + "/";

      if (pathname.startsWith(basePath)) {
        const webhookPath = pathname.slice(basePath.length);
        const gw = getGateway();
        const webhookHandler = createWebhookHandler(gw.scheduleStore, gw.scheduler, webhookConfig);
        Promise.resolve(webhookHandler(req, res, webhookPath)).catch(() => {
          if (!res.headersSent) {
            setSecurityHeaders(res);
            res.writeHead(500);
            res.end(JSON.stringify({ error: "Internal error" }));
          }
        });
        return;
      }
    }

    // 404 for everything else
    setSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  };
}

/**
 * @deprecated Use createRouteHandler() instead. Kept for backward compatibility in tests.
 */
export function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  let pathname: string;
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    pathname = url.pathname;
  } catch {
    setSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid URL" }));
    return;
  }

  const routes: Record<string, ReturnType<typeof withDefaults>> = {
    "/health": withDefaults(handleHealth),
    "/ready": withDefaults(handleReadiness),
  };

  const handler = routes[pathname];

  if (handler) {
    handler(req, res);
    return;
  }

  // 404 for everything else
  setSecurityHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}
