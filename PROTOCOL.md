# CrabMeat WebSocket Protocol

The wire contract between clients and the gateway in `src/gateway/`. Authoritative over what `src/gateway/ws/protocol.ts` implements; if the two disagree, this doc is the bug.

Protocol version: **1**, with v1.1 additions for non-LLM callers (see §2 caller roles, §3.6 `tool.invoke`, §3.7 `tools.list`, §4.10 `tools.changed`, §5 catalog row schema). All v1.1 additions are backward-compatible: existing v1 chat clients see no behavior change and may ignore everything below the dividers marked `(v1.1)`.

## Why this exists

The CrabMeat gateway was originally designed for a single client class: a CLI chat front-end driving an LLM through `chat.send`. The capability-ID indirection in `src/agents/tools/catalog.ts` exists because the LLM may be jailbroken and must not see real tool names. A second client class, a trusted shell that bypasses the LLM for high-confidence intents (Hermes is the first; future overlay clients will follow), has different requirements: it knows the real tool IDs, it executes against the catalog directly, and it needs the catalog exposed as data instead of as inline LLM tool declarations. v1.1 carves that surface out without changing the LLM-facing one.

## Frame envelope

Every frame is JSON, top-level shape:

```ts
interface Frame {
  id: string;
  type: "req" | "res" | "event" | "error";
}
```

Frame size limits:
- Pre-auth: 64 KB (`PRE_AUTH_MAX_BYTES`)
- Post-auth: 1 MB (`POST_AUTH_MAX_BYTES`)

Oversize frames close the socket with code 4001.

## 1. Handshake

The first frame after the WebSocket opens must be a `connect` request. Until it succeeds, the connection is unauthenticated, the 64 KB cap applies, and any other frame closes the socket. Handshake timeout is 10 seconds.

## 2. Connect (amended in v1.1)

### 2.1 Request

```ts
interface ConnectFrame {
  id: string;
  type: "req";
  method: "connect";
  params: {
    protocolVersion: 1;
    token?: string;
    password?: string;
    deviceId?: string;
    callerRole?: "shell" | "model_proxy" | "external";  // (v1.1) optional, defaults to "model_proxy"
  };
}
```

### 2.2 Caller roles (v1.1)

The role determines which methods the connection may call and how the tool surface is presented. Three roles are defined; two are implemented in v0.1.0.

| Role | Tool surface | Methods | Status |
|---|---|---|---|
| `shell` | real tool IDs, no capability indirection | `chat.*`, `command.exec`, `tool.invoke`, `tools.list` | implemented |
| `model_proxy` | per-session HMAC capability IDs (LLM-facing) | `chat.*`, `command.exec`, `user.answer` | implemented (default) |
| `external` | none | none | reserved; connect rejects with `ROLE_NOT_PERMITTED` |

Rules:

- **Default behavior is unchanged.** Frames without `callerRole` are treated as `model_proxy`. v1 clients keep working.
- **`shell` role bypasses capability minting.** `tool.invoke` accepts real tool IDs; `tools.list` returns real tool IDs. The trust assumption is that the shell process is the operator's own client, authenticated by the same token but trusted not to have been jailbroken the way an LLM might be.
- **`model_proxy` role keeps the existing capability indirection.** Tool declarations sent into the LLM context still use per-session HMAC capability IDs. The LLM never sees real tool names. `tool.invoke` is rejected for this role with `TOOL_INVOKE_REQUIRES_SHELL_ROLE` (see §6).
- **`external` is a slot, not a feature.** v0.1.0 rejects external connections at handshake time. The role exists in the schema so future third-party client classes (mobile companion, plugin runtime, CLI utilities outside the trust boundary) can be added without another protocol amendment.
- **Role is fixed for the lifetime of the connection.** Reconnect to change role.

### 2.3 Response

On success, the gateway responds with a `res` frame containing server info:

```ts
interface ConnectResponse {
  type: "res";
  replyTo: string;
  status: "ok";
  data: {
    serverInfo: {
      agent: string;
      provider: string;
      model: string;
      layer0: string;
      auth: string;
      tools: number;
      sessions: string;
    };
    callerRole: "shell" | "model_proxy";
    catalogGeneration?: string;  // (v1.1) present when role === "shell"
  };
}
```

`catalogGeneration` is the current tool catalog generation hash. Shell clients cache it and compare against `tools.changed` events to know when to refetch. See §5 for catalog semantics.

## 3. Request methods

All request methods listed below are valid post-handshake unless noted. Method availability per role is in §2.2.

### 3.1 chat.send

Unchanged from v1. Sends a user message; gateway streams response tokens via `chat.token` events and ends with `chat.done`. The synchronous `res` frame is an ack with the assigned `messageId`.

### 3.2 chat.queue

Unchanged from v1. Client-side interrupt lane: lets the user type while the agent is mid-turn. Buffered to the next safe boundary (between tool iterations). Control tokens like `--killbot` are fast-pathed and trip the circuit breaker without waiting for the loop to drain.

### 3.3 chat.history

Unchanged from v1. Returns recent transcript entries for the resolved session.

### 3.4 command.exec

Unchanged from v1. Slash-command surface: `/help`, `/status`, `/compact`, `/model`, `/doctor`, `/identity`, `/sessions`, `/schedules`, `/kill`, `/reset`. Returns text via `res`. Distinct from `tool.invoke`: commands are user-facing CLI verbs with text output; tool invocations are programmatic dispatch with structured returns.

### 3.5 user.answer

Unchanged from v1. Reply to a `user.question` event raised by the `ask-user-broker` tool.

---

### 3.6 tool.invoke (v1.1)

**Available to: `shell` role only.**

Direct programmatic dispatch of a registered tool. No LLM in the loop, no capability indirection. The dispatch path goes through the same handler registry, audit chain, dry-run policy, and effect-class enforcement as a Layer 0 auto-dispatch; the difference is that the classification decision was made client-side instead of server-side.

```ts
interface ToolInvokeFrame {
  id: string;
  type: "req";
  method: "tool.invoke";
  params: {
    toolId: string;
    arguments: Record<string, unknown>;
    dryRun?: boolean;          // default false; honored for tools that declare dryRunSupported
    sessionHint?: string;      // optional explicit session key; defaults to the caller's bound session
    confirmationToken?: string; // (see §3.6.2) required when policy demands it
  };
}
```

#### 3.6.1 Response

On success:

```ts
interface ToolInvokeResponse {
  type: "res";
  replyTo: string;
  status: "ok";
  data: {
    toolId: string;
    callId: string;
    content: string;                       // human-readable result
    isError: boolean;                      // tool-level failure flag
    outputs: Record<string, unknown>;      // structured outputs per tool's declared schema
    auditSeq: number;                      // audit log sequence number for this call
    dryRun: boolean;                       // echoes the request flag
  };
}
```

The `isError: true` case is **not** a protocol error. The handler ran, returned a structured failure, and that failure is the result. Protocol errors (tool not found, role denied, parameters invalid) come back as `status: "error"`; see §6.

#### 3.6.2 Confirmation gate

Tools with effect classes in the connection's `confirmEffects` set return `status: "error"`, `code: "CONFIRMATION_REQUIRED"`, and a `confirmationToken` in the error payload. The client has three paths:

- **Confirm.** Re-invoke with the same `arguments` plus the received `confirmationToken` to proceed. The token is single-use and consumed by the invocation.
- **Cancel.** Drop the token. It expires after 60 seconds and is removed from the gateway's pending set. No further action required from the client.
- **Confirm late.** Re-invoke with an expired or unknown token returns `status: "error"`, `code: "CONFIRMATION_TOKEN_EXPIRED"` (or `CONFIRMATION_TOKEN_INVALID` for never-issued tokens). The client should treat this as cancellation and re-issue the original `tool.invoke` from scratch; that returns a fresh `CONFIRMATION_REQUIRED` with a new token, and the user is re-prompted.

The expired-token path matters because UX latency is unpredictable: a user might walk away mid-prompt, an inline banner might be ignored, a voice confirmation might race with the next utterance. Returning a clean error and starting over is the correct behavior; clients must not silently retry a stale token, treat the expiry as a soft success, or hide the re-prompt from the user.

This mirrors the user-confirmation gate in `src/agents/layer0/classifier.ts`. The shell client owns the UX (modal, banner, voice prompt) but the policy lives server-side.

#### 3.6.3 Side effects

Every `tool.invoke` produces:

- One audit-chain entry (linked to prior entry's SHA-256, same shape as LLM-driven tool calls).
- One `tool.execute` event on the connection (status: `running` → `success`/`error`).
- One `audit.entry` event on the connection.

These match the events emitted for LLM-driven tool calls so audit consumers do not need to special-case shell-driven invocations.

### 3.7 tools.list (v1.1)

**Available to: `shell` role only.**

Returns the catalog of tools the connection may invoke.

```ts
interface ToolsListFrame {
  id: string;
  type: "req";
  method: "tools.list";
  params: {
    knownGeneration?: string;  // optional; if matches current generation, response is empty
  };
}
```

Response:

```ts
interface ToolsListResponse {
  type: "res";
  replyTo: string;
  status: "ok";
  data: {
    generation: string;        // catalog generation hash; opaque to client
    unchanged?: true;          // present when knownGeneration matched current
    tools: ToolCatalogRow[];   // omitted when unchanged
  };
}
```

`generation` is an opaque hash over the catalog content (tool IDs, names, descriptions, effect classes, schemas). When the catalog mutates (skill load/unload, hooks register a new tool, agent config reloads), the generation changes and a `tools.changed` event fires (§4.10).

The `knownGeneration` field is the cheap-refetch path: a client that already has generation `abc123` sends `tools.list` with `knownGeneration: "abc123"`, and if nothing changed the response is `{ generation: "abc123", unchanged: true }` with no payload. Bandwidth-cheap, supports lazy refresh.

#### 3.7.1 Catalog scope

`tools.list` returns the **currently-loaded** tools, not the union of everything the role might eventually invoke. Skills with lazy-load semantics (`src/skills/`) are not in the catalog until they are loaded; when a load completes, the catalog generation bumps and a `tools.changed` event fires (cause: `skill_loaded`). The client refetches at its own pace.

This is deliberate: returning lazy-available-but-not-yet-loaded tools would oblige clients to handle a "tool exists in catalog but `tool.invoke` returns `TOOL_NOT_FOUND` because it hasn't loaded yet" race, which is a worse contract than "what you see is what's invocable right now."

#### 3.7.2 Atomicity during catalog mutations

The catalog snapshot is atomic. While a skill is loading, hooks are registering tools, or an agent is reloading, `tools.list` returns the pre-mutation catalog and the pre-mutation generation. Partial states are never returned. When the mutation completes, the generation bumps and the `tools.changed` event fires; the next `tools.list` call (whether cheap-refetch or full) sees the new state.

The atomicity boundary is at the catalog read, not at the underlying mutation: a skill that takes several seconds to load is observable as "not yet present, then present" by clients polling or refetching across that window. Clients should not block on catalog stability; the hint+refetch loop converges naturally.

## 4. Events (server → client)

Existing events are unchanged from v1. The full set:

- `chat.token` — streamed inference token
- `chat.done` — turn complete
- `tool.execute` — tool lifecycle (running/success/error)
- `audit.entry` — audit chain entry written
- `command.recognized` — slash command matched
- `user.question` — agent requested operator input
- `message.outbound` — outbound delivery mirror (for connectors)
- `input.queued` — `chat.queue` ack
- `permission.request` — agent requested elevated permission
- `chat.cost` — per-turn cost delta and session running total

### 4.10 tools.changed (v1.1)

**Sent to: `shell` role only.**

Hint that the catalog has changed. Does not carry the catalog. The client refetches via `tools.list` when it next needs an authoritative view.

```ts
interface ToolsChangedEvent {
  type: "event";
  event: "tools.changed";
  data: {
    generation: string;        // new generation hash
    cause: "skill_loaded" | "skill_unloaded" | "agent_reload" | "hook_registered" | "other";
  };
}
```

Semantics:

- **Hint, not authoritative.** The event carries the new generation but no catalog rows. The client decides when to refetch.
- **Coalesced.** Multiple back-to-back catalog changes in a short window emit one event with the latest generation. The exact window is implementation-defined; clients must not depend on receiving one event per change.
- **Lossless across reconnect.** A reconnecting client sees `catalogGeneration` in the connect response (§2.3); if it differs from the cached value, the client refetches without needing to have observed the event.

## 5. Tool catalog row schema (v1.1)

```ts
interface ToolCatalogRow {
  toolId: string;
  name: string;
  description: string;
  effectClass: "read" | "write" | "network" | "exec" | "privileged";
  speculationSafe: boolean;
  dryRunSupported: boolean;
  parametersSchema: object;    // JSON Schema for the tool's parameters
  outputsSchema: object;       // JSON Schema for the tool's structured outputs
}
```

Field notes:

- **`speculationSafe`** is derived: `effectClass === "read"`. Kept as an explicit field so future policy changes (a network-but-idempotent class, a write-to-temp class) can flip it without clients having to know the derivation rule.
- **`dryRunSupported`** is true for tools whose handlers honor `params.dryRun`. The current set: `file_move`, `file_copy`, `file_write` (overwrite path), `shell`. Tools may opt in by accepting `dryRun` in their parameter schema and respecting it in the handler.
- **`parametersSchema`** mirrors the zod schema in the tool definition, serialized as JSON Schema. Clients use this for client-side argument validation before invoking.
- **`outputsSchema`** is informational. Handlers may populate fewer keys than declared; clients should treat missing keys as `undefined`, not as protocol violations.

The catalog is filtered per agent: rows correspond to the tools in the agent's resolved `allowedEffects` and (where applicable) skill-loaded extensions. Two `shell` connections bound to different agents may see different catalogs.

## 6. Errors

Errors come back as `res` frames with `status: "error"` and an `error: { code, message }` payload, or as top-level `error` events for connection-level failures.

Existing error codes from v1 are unchanged. The v1.1 additions:

| Code | When |
|---|---|
| `ROLE_NOT_PERMITTED` | Connect attempted with a role the gateway does not implement (`external` in v0.1.0). |
| `TOOL_INVOKE_REQUIRES_SHELL_ROLE` | `tool.invoke` or `tools.list` from a non-shell connection. |
| `TOOL_NOT_FOUND` | `params.toolId` does not exist in the agent's catalog. |
| `TOOL_DENIED_BY_EFFECT` | Tool exists but the agent's `allowedEffects` excludes its effect class. |
| `INVALID_TOOL_ARGUMENTS` | `params.arguments` failed zod validation against the tool's parameter schema. The error message includes the zod issue summary. |
| `CONFIRMATION_REQUIRED` | Tool requires user confirmation; error payload includes a `confirmationToken` (see §3.6.2). |
| `CONFIRMATION_TOKEN_EXPIRED` | A `tool.invoke` carried a `confirmationToken` that has aged past its 60-second TTL. Client should re-issue the original invocation to receive a fresh token. |
| `CONFIRMATION_TOKEN_INVALID` | A `tool.invoke` carried a `confirmationToken` that was never issued by the gateway (or was already consumed by a prior invocation; tokens are single-use). Same recovery as `CONFIRMATION_TOKEN_EXPIRED`. |
| `DRY_RUN_NOT_SUPPORTED` | `params.dryRun: true` for a tool that does not declare `dryRunSupported`. |
| `CATALOG_GENERATION_MISMATCH` | Reserved for future use (e.g. `tool.invoke` carrying a `generationHint` that no longer matches). Not emitted in v0.1.0. |

All error codes follow `SCREAMING_SNAKE_CASE`. New codes added in future amendments must follow the same convention.

## 7. Backward compatibility

v1 clients:

- **Continue working without changes.** Missing `callerRole` defaults to `model_proxy`; no v1.1-only methods or events are sent on those connections.
- **May safely ignore unknown fields** in responses (e.g. `catalogGeneration`). Standard JSON forward-compatibility applies: additive fields, no breaking renames.
- **May safely ignore unknown event types** if a future amendment ever sends one. The current spec only sends `tools.changed` to shell connections.

v1.1 clients connecting to a v1 server:

- The `connect` response will not include `catalogGeneration` and the server will not honor `callerRole`. The client should detect this by the missing field and fall back to v1 behavior (`chat.send` only, no `tool.invoke`, no `tools.list`).
- A v1 server will reject `tool.invoke` and `tools.list` with `INVALID_METHOD` (existing v1 error). Treat that as "server too old" rather than as a transient error.

Server-side handling of unknown fields: Zod parses with the defaults; unknown keys on input frames are ignored. New fields added in future amendments must be optional and must default to v1.1 behavior.

## 8. Amendments

### 2026-04-28 — v1.1 (Hermes boundary)

**Modifies:** §2 connect (adds `callerRole`); §3 (adds `tool.invoke`, `tools.list`); §4 (adds `tools.changed`); §5 (new catalog row schema); §6 (new error codes).

**Reason:** A trusted-shell client class is required for Hermes v0 and any future overlay clients that bypass the LLM for high-confidence intents. Capability-ID indirection is a defense against jailbroken LLMs and is the wrong policy for non-LLM callers, who already know the real tool IDs and need structured catalog access. Layer 0 already implements the dry-run, confirmation, and audit-trail policy server-side; v1.1 lets non-LLM callers inherit it without reimplementing it client-side.

**Scope of changes:** all additive. No existing method, event, or field semantics changed. Existing v1 clients see no behavior difference.

**Out of scope (deliberately):**
- The `external` role is reserved but not implemented. Adding third-party client policy is its own design exercise (sandboxing, rate limits, scoped tool subsets) and does not block Hermes.
- Tool catalog filtering by skill or runtime context. The catalog returned by `tools.list` is the agent's full available set; per-call filtering (e.g. "only file tools right now") is a client concern.
- Subscription-style streaming of `tools.list` results. The hint+refetch pattern is sufficient for the expected catalog churn rate (skill loads, agent reloads: minutes-to-hours, not per-second).

### 2026-04-28 — versioning note

This is the first standing protocol document. Earlier protocol behavior is reconstructed from `src/gateway/ws/protocol.ts` and is treated as v1. Future amendments append here with a date, the sections they touch, and a one-paragraph rationale.
