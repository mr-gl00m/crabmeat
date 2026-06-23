export type EffectClass =
  | "read"
  | "write"
  | "search"
  | "exec"
  | "network"
  | "privileged";

export type IntentAction = "file_write" | "file_read" | "web_search";

export interface Intent {
  readonly id: string;
  readonly action: IntentAction;
  readonly params: Readonly<Record<string, unknown>>;
  readonly effectClass: EffectClass;
  readonly parsedAt: number;
  consultedAt?: number;
  // RT-2026-04-30-010 — second signature covering (intentId, consultedAt,
  // consultationHash). Bound at consult time; verified at execute time. Stops
  // a tampered consultedAt from bypassing the consultToExecuteMaxMs window.
  consultationSignature?: string;
  readonly signature?: string;
  readonly decodedFrom?: string;
}

export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ProviderChunk {
  readonly delta: string;
}

export type ProviderFn = (
  messages: readonly ProviderMessage[],
) => AsyncIterable<ProviderChunk>;

export interface Consultation {
  readonly intentId: string;
  readonly text: string;
  readonly hash: string;
  readonly receivedAt: number;
}

export type ReconciliationOutcome =
  | "approved"
  | "rejected"
  | "refined"
  | "exhausted";

export interface Reconciliation {
  readonly outcome: ReconciliationOutcome;
  readonly reason: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly round: number;
}

export interface ExecuteArgs {
  readonly consultation?: Consultation;
  readonly reconciliation?: Reconciliation;
}

export interface Result {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
}

export interface ParseOpts {
  readonly workspace?: string;
  readonly auditDb?: unknown;
  readonly maxInputBytes?: number;
}

export interface ConsultOpts {
  readonly systemPrompt?: string;
  readonly maxConsultBytes?: number;
}

export interface HandleOpts extends ParseOpts, ConsultOpts {
  readonly parseToConsultMaxMs?: number;
  readonly consultToExecuteMaxMs?: number;
  readonly skipHitl?: boolean;
}
