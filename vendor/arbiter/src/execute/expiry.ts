import type { Intent } from "../types.js";

export const DEFAULT_PARSE_TO_CONSULT_MAX_MS = 120_000;
export const DEFAULT_CONSULT_TO_EXECUTE_MAX_MS = 300_000;

export interface ExpiryWindows {
  readonly parseToConsultMaxMs: number;
  readonly consultToExecuteMaxMs: number;
}

export interface ExpiryCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkExpiry(
  intent: Intent,
  now: number,
  windows: ExpiryWindows,
): ExpiryCheck {
  if (intent.consultedAt === undefined) {
    return {
      ok: false,
      reason: "consultedAt not set; consult() must run before execute()",
    };
  }
  const parseToConsult = intent.consultedAt - intent.parsedAt;
  if (parseToConsult > windows.parseToConsultMaxMs) {
    return {
      ok: false,
      reason: `parse->consult window exceeded (${parseToConsult}ms > ${windows.parseToConsultMaxMs}ms)`,
    };
  }
  if (parseToConsult < 0) {
    return {
      ok: false,
      reason: "consultedAt precedes parsedAt (clock skew or tampered intent)",
    };
  }
  const consultToExecute = now - intent.consultedAt;
  if (consultToExecute > windows.consultToExecuteMaxMs) {
    return {
      ok: false,
      reason: `consult->execute window exceeded (${consultToExecute}ms > ${windows.consultToExecuteMaxMs}ms)`,
    };
  }
  if (consultToExecute < 0) {
    return {
      ok: false,
      reason: "consultedAt is in the future (clock skew or tampered intent)",
    };
  }
  return { ok: true };
}
