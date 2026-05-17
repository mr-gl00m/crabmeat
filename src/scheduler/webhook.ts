/**
 * Webhook handler for triggering scheduled tasks via HTTP POST.
 *
 * Routes: POST /hook/<path> → finds matching schedule → triggers execution.
 * Secret validation via timing-safe comparison when requireSecret is enabled.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SchedulerEngine } from "./engine.js";
import type { ScheduleStore } from "./store.js";
import type { WebhookConfig } from "../config/types.js";
import { setSecurityHeaders } from "../security/headers.js";
import { secretEqual } from "../security/secret-equal.js";
import { logger } from "../infra/logger.js";
import { formatErrorMessage } from "../infra/errors.js";

/** Validate that a webhook path contains only safe characters. */
function isSafeWebhookPath(path: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(path);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  setSecurityHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

export function createWebhookHandler(
  scheduleStore: ScheduleStore,
  engine: SchedulerEngine,
  config: WebhookConfig,
) {
  return async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    // Only POST allowed
    if (req.method !== "POST") {
      jsonResponse(res, 405, { error: "Method not allowed" });
      return;
    }

    // Validate path format
    if (!isSafeWebhookPath(webhookPath)) {
      jsonResponse(res, 400, { error: "Invalid webhook path" });
      return;
    }

    // Find matching schedule
    const schedules = await scheduleStore.loadAll();
    const match = schedules.find((s) => {
      if (!s.trigger) return false;
      if (s.trigger.type === "webhook" || s.trigger.type === "both") {
        return s.trigger.path === webhookPath && s.enabled;
      }
      return false;
    });

    if (!match) {
      jsonResponse(res, 404, { error: "No schedule matches this webhook path" });
      return;
    }

    // Secret validation
    const trigger = match.trigger!;
    const secret = (trigger.type === "webhook" || trigger.type === "both") ? trigger.secret : undefined;

    if (config.requireSecret) {
      if (!secret) {
        jsonResponse(res, 403, { error: "Webhook has no secret configured but requireSecret is enabled" });
        return;
      }

      const authHeader = req.headers.authorization ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

      if (!bearerToken || !secretEqual(bearerToken, secret)) {
        jsonResponse(res, 401, { error: "Invalid or missing webhook secret" });
        return;
      }
    }

    // Trigger execution
    logger.info({ scheduleId: match.id, webhookPath }, "Webhook triggered schedule");

    try {
      const result = await engine.triggerNow(match.id);
      if (!result) {
        jsonResponse(res, 409, { error: "Schedule is currently executing or not found" });
        return;
      }

      jsonResponse(res, 200, {
        scheduleId: match.id,
        scheduleName: match.name,
        status: "triggered",
        hadErrors: result.hadErrors,
        durationMs: result.durationMs,
      });
    } catch (err) {
      logger.error({ error: formatErrorMessage(err), scheduleId: match.id }, "Webhook trigger failed");
      jsonResponse(res, 500, { error: "Schedule execution failed" });
    }
  };
}
