import type { IncomingMessage, ServerResponse } from "node:http";

// GET/HEAD only. Without this, `curl -X POST /health` returns 200 which
// misleads monitoring tools and lets a misconfigured client push arbitrary
// bodies to an endpoint that advertises no behavior.
function rejectNonRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  res.writeHead(405, { Allow: "GET, HEAD" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
  return true;
}

export function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  if (rejectNonRead(req, res)) return;
  res.writeHead(200);
  res.end(JSON.stringify({ status: "ok" }));
}

export function handleReadiness(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (rejectNonRead(req, res)) return;
  res.writeHead(200);
  res.end(JSON.stringify({ ready: true }));
}
