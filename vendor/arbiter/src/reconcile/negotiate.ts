import { initAuditDb, type AuditDb } from "../audit/db.js";
import { appendAuditRow } from "../audit/append.js";
import { runConsult } from "../consult/index.js";
import type { Intent, ProviderFn, Reconciliation } from "../types.js";
import {
  DEFAULT_TOOL_CATALOG,
  permissionCone,
  type ToolDef,
} from "./cone.js";
import { reconcileImpl } from "./index.js";

export interface NegotiateOpts {
  readonly maxRounds?: number;
  readonly catalog?: readonly ToolDef[];
  readonly auditDb?: AuditDb;
}

function planCheckPrompt(
  intent: Intent,
  catalog: readonly ToolDef[],
  feedback: string | null,
): string {
  const cone = permissionCone(intent, catalog);
  const lines = [
    "You respond to a parsed user intent that has already been validated.",
    'Output exactly one JSON object: {"tool": "...", "args": {...}}.',
    "No preamble. No code fences. No commentary. JSON only.",
    `Allowed tools for this intent (${intent.action}): ${cone
      .map((t) => `${t.name}(${t.required.join(", ")})`)
      .join(", ") || "none"}.`,
    "The intent's destination/identifier fields are authoritative — your role is to fill in the LLM-provided args (e.g. `content` for file_write).",
  ];
  if (feedback !== null) {
    lines.push("");
    lines.push(`Previous round was rejected: ${feedback}`);
    lines.push("Fix that rejection in this round.");
  }
  return lines.join("\n");
}

export async function negotiate(
  intent: Intent,
  providerFn: ProviderFn,
  opts: NegotiateOpts = {},
): Promise<Reconciliation> {
  const maxRounds = opts.maxRounds ?? 2;
  const catalog = opts.catalog ?? DEFAULT_TOOL_CATALOG;
  const db = opts.auditDb ?? initAuditDb();
  const owns = opts.auditDb === undefined;

  let lastFeedback: string | null = null;
  const rejections: string[] = [];

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const consultation = await runConsult(intent, providerFn, {
        systemPrompt: planCheckPrompt(intent, catalog, lastFeedback),
        auditDb: db,
      });

      const result = reconcileImpl(intent, consultation, { round, catalog });

      appendAuditRow(db, {
        kind: "reconciliation",
        intentId: intent.id,
        payload: {
          round,
          outcome: result.outcome,
          reason: result.reason,
          consultationHash: consultation.hash,
        },
      });

      if (result.outcome === "approved" || result.outcome === "refined") {
        return result;
      }
      rejections.push(`round ${round}: ${result.reason}`);
      lastFeedback = result.reason;
    }

    return {
      outcome: "exhausted",
      reason: `negotiation budget exhausted after ${maxRounds} rounds`,
      round: maxRounds,
    };
  } finally {
    if (owns) db.close();
  }
}
