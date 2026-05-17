/**
 * echo — dev-only loopback connector.
 *
 * Writes outbound messages to the gateway log and returns ok. Zero
 * external side effects — useful for local dogfooding of message_send
 * without needing a real Discord/Telegram/Slack webhook on hand.
 *
 * NOT suitable for production: "delivered" here means "printed to
 * the gateway log", not "reached a human". The mirror broker still
 * fires, so CLI users will see the message render locally.
 */

import { logger } from "../infra/logger.js";
import type {
  OutboundConnector,
  OutboundDeliverOptions,
  OutboundDeliverResult,
} from "./outbound.js";

export interface EchoConnectorOptions {
  id?: string;
}

export function createEchoConnector(
  opts: EchoConnectorOptions = {},
): OutboundConnector {
  const id = opts.id ?? "echo";

  async function deliver(
    o: OutboundDeliverOptions,
  ): Promise<OutboundDeliverResult> {
    logger.info(
      {
        connector: id,
        sessionKey: o.sessionKey,
        contentLen: o.content.length,
        killUrl: o.killUrl || undefined,
        reason: o.reason,
      },
      `echo connector: outbound message`,
    );
    return { ok: true };
  }

  return {
    id,
    name: "echo",
    trustLevel: "standard",
    deliver,
  };
}
