import type { IncomingMessage, ServerResponse } from "node:http";
import { setSecurityHeaders } from "../../security/headers.js";

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** Wrap a handler with security headers and JSON content type. */
export function withDefaults(handler: HttpHandler): HttpHandler {
  return (req, res) => {
    setSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json");
    return handler(req, res);
  };
}
