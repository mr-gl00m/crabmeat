import { initAuditDb, type AuditDb } from "../audit/db.js";
import { appendAuditRow } from "../audit/append.js";
import { sha256Hex } from "../audit/hash.js";
import { loadOrCreateKeyPairSync } from "../sign/keys.js";
import { verifyConsultation, verifyIntent } from "../sign/sign.js";
import {
  DEFAULT_CONSULT_TO_EXECUTE_MAX_MS,
  DEFAULT_PARSE_TO_CONSULT_MAX_MS,
  checkExpiry,
} from "./expiry.js";
import {
  hitlPaths,
  requiresHitl,
  writePendingAndWait,
  type HitlOpts,
} from "./hitl.js";
import { execFileRead, execFileWrite, execWebSearch } from "./tools.js";
import type { ExecuteArgs, Intent, Result } from "../types.js";

export interface ExecuteRuntimeOpts {
  readonly workspace?: string;
  readonly auditDb?: AuditDb;
  readonly parseToConsultMaxMs?: number;
  readonly consultToExecuteMaxMs?: number;
  readonly hitl?: HitlOpts;
  readonly skipHitl?: boolean;
}

// RT-2026-04-30-002 — file_read output carries the entire file body. Storing
// it verbatim in the audit row leaks file contents into audit.db and bloats it.
// Mirror the consultation row's metadata-only pattern: hash + length.
function redactExecutionOutput(
  action: Intent["action"],
  output: unknown,
): unknown {
  if (action !== "file_read" || output === null || typeof output !== "object") {
    return output;
  }
  const o = output as { readFrom?: unknown; content?: unknown };
  if (typeof o.content !== "string") return output;
  return {
    readFrom: o.readFrom,
    bytes: Buffer.byteLength(o.content, "utf-8"),
    contentHash: sha256Hex(o.content),
  };
}

function buildArgs(
  intent: Intent,
  args: ExecuteArgs,
): Record<string, unknown> {
  if (args.reconciliation?.args !== undefined) {
    return { ...(args.reconciliation.args as Record<string, unknown>) };
  }
  const merged: Record<string, unknown> = {
    ...(intent.params as Record<string, unknown>),
  };
  if (intent.action === "file_write" && args.consultation !== undefined) {
    merged["content"] = args.consultation.text;
  }
  return merged;
}

export async function runExecute(
  intent: Intent,
  args: ExecuteArgs = {},
  opts: ExecuteRuntimeOpts = {},
): Promise<Result> {
  const workspace = opts.workspace ?? process.cwd();
  const db = opts.auditDb ?? initAuditDb();
  const owns = opts.auditDb === undefined;

  try {
    const kp = loadOrCreateKeyPairSync();
    if (!verifyIntent(intent, kp.publicKey)) {
      const reason = "intent signature verification failed";
      appendAuditRow(db, {
        kind: "execution",
        intentId: intent.id,
        payload: { ok: false, reason },
      });
      return { ok: false, error: reason };
    }

    // RT-2026-04-30-010 — verify the consultation signature (binds intentId,
    // consultedAt, and consultationHash). Skip the check when no consultation
    // is supplied — the executor handles consultation-less paths (HITL-only
    // flows that approve on the parsed intent alone) elsewhere; expiry
    // already rejects when consultedAt is unset.
    if (
      args.consultation !== undefined &&
      intent.consultedAt !== undefined
    ) {
      const sig = intent.consultationSignature;
      if (
        sig === undefined ||
        !verifyConsultation(
          intent.id,
          intent.consultedAt,
          args.consultation.hash,
          sig,
          kp.publicKey,
        )
      ) {
        const reason = "consultation signature verification failed";
        appendAuditRow(db, {
          kind: "execution",
          intentId: intent.id,
          payload: { ok: false, reason },
        });
        return { ok: false, error: reason };
      }
    }

    const expiry = checkExpiry(intent, Date.now(), {
      parseToConsultMaxMs:
        opts.parseToConsultMaxMs ?? DEFAULT_PARSE_TO_CONSULT_MAX_MS,
      consultToExecuteMaxMs:
        opts.consultToExecuteMaxMs ?? DEFAULT_CONSULT_TO_EXECUTE_MAX_MS,
    });
    if (!expiry.ok) {
      appendAuditRow(db, {
        kind: "execution",
        intentId: intent.id,
        payload: { ok: false, reason: expiry.reason },
      });
      return { ok: false, error: expiry.reason };
    }

    if (requiresHitl(intent) && opts.skipHitl !== true) {
      const reconciliation = args.reconciliation ?? {
        outcome: "approved" as const,
        reason: "no reconciliation provided; HITL gated by effectClass",
        round: 1,
      };
      const paths = hitlPaths(intent, opts.hitl?.dir);
      appendAuditRow(db, {
        kind: "hitl.pending",
        intentId: intent.id,
        payload: paths,
      });
      const wait = await writePendingAndWait(intent, reconciliation, opts.hitl);
      if (!wait.approved) {
        appendAuditRow(db, {
          kind: "execution",
          intentId: intent.id,
          payload: { ok: false, reason: wait.reason },
        });
        return { ok: false, error: wait.reason };
      }
      appendAuditRow(db, {
        kind: "hitl.approved",
        intentId: intent.id,
        payload: { signedPath: wait.signedPath },
      });
    }

    const toolArgs = buildArgs(intent, args);
    let result: Result;
    switch (intent.action) {
      case "file_write":
        result = await execFileWrite(toolArgs, workspace);
        break;
      case "file_read":
        result = await execFileRead(toolArgs, workspace);
        break;
      case "web_search":
        result = execWebSearch(toolArgs);
        break;
    }

    appendAuditRow(db, {
      kind: "execution",
      intentId: intent.id,
      payload: {
        ok: result.ok,
        action: intent.action,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.output !== undefined
          ? { output: redactExecutionOutput(intent.action, result.output) }
          : {}),
      },
    });
    return result;
  } finally {
    if (owns) db.close();
  }
}
