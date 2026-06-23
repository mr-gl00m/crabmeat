import { parseRequest } from "./parse/index.js";
import { isUnsafeWorkspace } from "./parse/path-jail.js";
import { normalize } from "./normalize/index.js";
import { runConsult } from "./consult/index.js";
import { reconcileImpl } from "./reconcile/index.js";
import { runExecute } from "./execute/index.js";
import { loadOrCreateKeyPairSync } from "./sign/keys.js";
import { signIntent } from "./sign/sign.js";
import { appendAuditRow } from "./audit/append.js";
import type { AuditDb } from "./audit/db.js";
import type {
  Consultation,
  ConsultOpts,
  ExecuteArgs,
  HandleOpts,
  Intent,
  ParseOpts,
  ProviderFn,
  Reconciliation,
  Result,
} from "./types.js";

export type {
  Consultation,
  ConsultOpts,
  EffectClass,
  ExecuteArgs,
  HandleOpts,
  Intent,
  IntentAction,
  ParseOpts,
  ProviderChunk,
  ProviderFn,
  ProviderMessage,
  Reconciliation,
  ReconciliationOutcome,
  Result,
} from "./types.js";

export {
  AppError,
  IntentExpiredError,
  NotFoundError,
  NotImplementedError,
  SignatureError,
  ValidationError,
  formatError,
  isRetryable,
} from "./errors.js";

export type { ExecuteRuntimeOpts } from "./execute/index.js";

export { initAuditDb } from "./audit/db.js";
export type { AuditDb } from "./audit/db.js";

export {
  atomicWriteJson,
  atomicWriteText,
  atomicWriteTextSync,
  fileExists,
  readJsonFile,
  readText,
} from "./io/atomic.js";

export {
  loadOrCreateKeyPair,
  loadOrCreateKeyPairSync,
  resetKeyPairCache,
} from "./sign/keys.js";
export type { KeyPair } from "./sign/keys.js";

export { canonicalize, signIntent, verifyIntent } from "./sign/sign.js";

export { appendAuditRow, verifyChain } from "./audit/append.js";
export type { AuditAppendInput, AuditKind, AuditRow, ChainCheck } from "./audit/append.js";
export { sha256Hex, GENESIS_HASH } from "./audit/hash.js";

export { composeMessages } from "./consult/prompts.js";
export type { ComposedMessages } from "./consult/prompts.js";
export { escapeForPrompt } from "./consult/escape.js";

export {
  DEFAULT_TOOL_CATALOG,
  permissionCone,
} from "./reconcile/cone.js";
export type { ToolDef } from "./reconcile/cone.js";
export { parseProposal } from "./reconcile/proposal.js";
export type { Proposal } from "./reconcile/proposal.js";
export { negotiate } from "./reconcile/negotiate.js";
export type { NegotiateOpts } from "./reconcile/negotiate.js";

export {
  DEFAULT_CONSULT_TO_EXECUTE_MAX_MS,
  DEFAULT_PARSE_TO_CONSULT_MAX_MS,
  checkExpiry,
} from "./execute/expiry.js";
export type { ExpiryCheck, ExpiryWindows } from "./execute/expiry.js";
export {
  HITL_EFFECT_CLASSES,
  hitlPaths,
  requiresHitl,
  writePendingAndWait,
} from "./execute/hitl.js";
export type {
  HitlOpts,
  HitlPaths,
  HitlWaitResult,
} from "./execute/hitl.js";

// RT-2026-04-30-005 — bound the request size at the library boundary so the
// downstream decode chain (homoglyph fold, base64/hex/url decoders) cannot be
// driven into multi-hundred-MB allocations by a single oversized chat frame.
// 64 KiB is well above any realistic short-form user request; consumers
// needing longer can override via ParseOpts.maxInputBytes.
export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;

export function extractIntent(
  request: string,
  opts: ParseOpts = {},
): Intent | null {
  const maxBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (Buffer.byteLength(request, "utf-8") > maxBytes) {
    return null;
  }
  const workspace = opts.workspace ?? process.cwd();
  // RT-2026-04-30-007 — refuse a workspace that equals $HOME, the fs root, or
  // a system directory. The consuming project (CrabMeat) currently passes
  // process.cwd() and never narrows it; this guard catches the misconfig.
  const wsCheck = isUnsafeWorkspace(workspace);
  if (wsCheck.unsafe) {
    return null;
  }
  const db = opts.auditDb as AuditDb | undefined;

  if (db !== undefined) {
    const norm = normalize(request);
    if (norm.decodedFrom.length > 0) {
      appendAuditRow(db, {
        kind: "intent.normalized",
        payload: { decodedFrom: [...norm.decodedFrom] },
      });
    }
  }

  const parsed = parseRequest({ request, workspace });
  if (parsed === null) return null;

  if (db !== undefined) {
    appendAuditRow(db, {
      kind: "intent.parsed",
      intentId: parsed.intent.id,
      payload: {
        action: parsed.intent.action,
        effectClass: parsed.intent.effectClass,
        ...(parsed.decodedFrom.length > 0
          ? { decodedFrom: [...parsed.decodedFrom] }
          : {}),
      },
    });
  }

  const kp = loadOrCreateKeyPairSync();
  const signature = signIntent(parsed.intent, kp.privateKey);
  return { ...parsed.intent, signature };
}

export async function consult(
  intent: Intent,
  providerFn: ProviderFn,
  opts: ConsultOpts = {},
): Promise<Consultation> {
  return runConsult(intent, providerFn, {
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
  });
}

export function reconcile(
  intent: Intent,
  consultation: Consultation,
): Reconciliation {
  return reconcileImpl(intent, consultation);
}

export async function execute(
  intent: Intent,
  args: ExecuteArgs = {},
  runtimeOpts: import("./execute/index.js").ExecuteRuntimeOpts = {},
): Promise<Result> {
  return runExecute(intent, args, runtimeOpts);
}

export async function handle(
  request: string,
  providerFn: ProviderFn,
  opts: HandleOpts = {},
): Promise<Result> {
  const intent = extractIntent(request, opts);
  if (intent === null) {
    return {
      ok: false,
      error: "request did not parse to a recognized intent",
    };
  }
  const consultation = await consult(intent, providerFn, opts);
  const runtimeOpts: import("./execute/index.js").ExecuteRuntimeOpts = {
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    ...(opts.auditDb !== undefined
      ? { auditDb: opts.auditDb as import("./audit/db.js").AuditDb }
      : {}),
    ...(opts.parseToConsultMaxMs !== undefined
      ? { parseToConsultMaxMs: opts.parseToConsultMaxMs }
      : {}),
    ...(opts.consultToExecuteMaxMs !== undefined
      ? { consultToExecuteMaxMs: opts.consultToExecuteMaxMs }
      : {}),
    ...(opts.skipHitl !== undefined ? { skipHitl: opts.skipHitl } : {}),
  };
  return execute(intent, { consultation }, runtimeOpts);
}
