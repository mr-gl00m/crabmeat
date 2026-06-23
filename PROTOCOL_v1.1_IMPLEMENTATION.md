# Protocol v1.1 — Implementation Punchlist

Sibling to `PROTOCOL.md`. The contract doc is the *what*; this doc is the *where* — every protocol addition mapped to a concrete file, function, and test path in the existing tree. Tracking lives here so the contract stays clean.

Status legend:
- `[ ]` not started
- `[~]` in progress
- `[x]` complete

When a line is finished, flip the box and leave the rest in place. The history of what got built is useful; deletion is not.

## 0. Pre-work — connection-level role state

Before any v1.1 method works, the connection has to know which role it's bound to. That state is set at handshake time and read by every method dispatcher.

**Files:**
- `src/gateway/ws/protocol.ts` — `connectParamsSchema:12` adds optional `callerRole: z.enum(["shell", "model_proxy", "external"]).default("model_proxy")`.
- `src/gateway/ws/handshake.ts:87` — extend `HandshakeResult` with `callerRole`. Reject `external` here with code 4010 + `ROLE_NOT_PERMITTED` error frame.
- `src/gateway/ws/handler.ts:72` — `attachMessageHandler` signature gains `callerRole: "shell" | "model_proxy"`. Plumbed through from the handshake result in the caller (likely `src/gateway/server.ts`).
- `src/gateway/server.ts` — pass the role from `performHandshake` result into `attachMessageHandler`.

**Tasks:**
- [ ] Add `callerRole` to `connectParamsSchema` with default `"model_proxy"`.
- [ ] Surface `callerRole` on `HandshakeResult`.
- [ ] Reject `external` in `performHandshake` before authenticate-success, with `ROLE_NOT_PERMITTED` error frame and 4010 close code.
- [ ] Thread `callerRole` from server.ts into `attachMessageHandler`.
- [ ] Add `catalogGeneration` to the `serverInfo`-returning success branch when `callerRole === "shell"` (depends on §5).
- [ ] Test: handshake.test.ts gets three new cases — explicit shell role accepted, explicit model_proxy accepted, external rejected with code 4010.

## 1. tool.invoke method

The largest single addition. The handler dispatches the call into the existing `executeValidatedTool` plumbing and wraps the result back into a `res` frame.

**Files:**
- `src/gateway/ws/protocol.ts` — new `toolInvokeFrameSchema` and `toolInvokeResponseSchema`. Add to the `requestFrameSchema` discriminated union at line 100.
- `src/gateway/ws/handler.ts:147` — new `case "tool.invoke"` in the dispatch switch.
- `src/gateway/ws/handler.ts` — new `handleToolInvoke` function below `handleCommandExec:731`.
- `src/agents/tools/invoke.ts` — `executeValidatedTool:21` is the existing entry point; no changes needed there. The handler builds the `ValidatedInvocation` from frame params.
- `src/agents/tools/catalog.ts` — `ToolCatalog` interface gets a method `getToolByRealId(toolId: string): ToolDefinition | undefined` to bypass capability resolution for shell callers.

**Tasks:**
- [ ] Define `toolInvokeParamsSchema`, `toolInvokeFrameSchema`, response shape in `protocol.ts`.
- [ ] Wire `tool.invoke` into `requestFrameSchema` discriminated union.
- [ ] Add `getToolByRealId` to `ToolCatalog` interface and implementation.
- [ ] Implement `handleToolInvoke` in `handler.ts`:
  - Reject if `callerRole !== "shell"` with `TOOL_INVOKE_REQUIRES_SHELL_ROLE`.
  - Resolve session: use `sessionHint` if present, else fall back to the connection's primary session from `ownedSessions` (claim if first time, with the same MAX_OWNED_SESSIONS guard as `chat.send`).
  - Look up tool by real ID; reject with `TOOL_NOT_FOUND` if missing.
  - Effect-class check against agent's `allowedEffects`; reject with `TOOL_DENIED_BY_EFFECT` if excluded.
  - Validate `arguments` against tool's parameter zod schema; reject with `INVALID_TOOL_ARGUMENTS` and pass the zod issue summary in `error.message`.
  - Confirmation gate (see §6): if effect class is in `confirmEffects` and no valid `confirmationToken` provided, mint one and return `CONFIRMATION_REQUIRED`.
  - Build `ValidatedInvocation`, call `executeValidatedTool`.
  - Audit chain: `executeValidatedTool` already records; capture `auditSeq` from the audit log entry.
  - Return `res` with `{ toolId, callId, content, isError, outputs, auditSeq, dryRun }`.
- [ ] Emit `tool.execute` events at `running` and `success`/`error` boundaries (matches LLM-driven path).
- [ ] Emit `audit.entry` event after the audit write.
- [ ] Test: `handler.test.ts` covers role rejection, tool-not-found, effect-denied, args-invalid, dry-run-not-supported, success path with structured outputs, error path with `isError: true` returning `status: "ok"`.
- [ ] Test: integration test verifies `auditSeq` matches the chain entry written for the call.

## 2. tools.list method

Returns the per-agent catalog snapshot. Cheap-refetch via `knownGeneration`.

**Files:**
- `src/gateway/ws/protocol.ts` — `toolsListFrameSchema`, response shape with `unchanged?: true` and `tools?: ToolCatalogRow[]`.
- `src/gateway/ws/handler.ts` — new `case "tools.list"` and `handleToolsList`.
- `src/agents/tools/catalog.ts` — new method `getCatalogRows(agentConfig: AgentConfig): ToolCatalogRow[]` returning the structured rows; new method `getGeneration(): string` returning the current opaque hash.
- `src/agents/tools/types.ts` — new `ToolCatalogRow` interface (matches PROTOCOL.md §5).

**Tasks:**
- [ ] Define `ToolCatalogRow` in `types.ts`.
- [ ] Define `toolsListParamsSchema`, `toolsListFrameSchema`, response shape in `protocol.ts`.
- [ ] Wire `tools.list` into `requestFrameSchema`.
- [ ] Add `getCatalogRows` to `ToolCatalog` — derives `speculationSafe` as `!HIGH_IMPACT_EFFECTS.has(effectClass)` (already in `tools/types.ts:13`); derives `dryRunSupported` from a tool-level metadata field added in §3 below.
- [ ] Add `getGeneration` to `ToolCatalog` — returns a hash of (toolId, name, description, effectClass, parameterSchema-JSON) for every tool in the active set, sorted, hashed via SHA-256, hex-encoded, first 16 chars. Recomputed on demand from current state.
- [ ] Implement `handleToolsList`:
  - Reject if `callerRole !== "shell"` with `TOOL_INVOKE_REQUIRES_SHELL_ROLE` (same code; method-class restriction).
  - Compute current generation.
  - If `params.knownGeneration === currentGen`, return `{ generation, unchanged: true }`.
  - Otherwise return `{ generation, tools: rows }`.
- [ ] Test: `catalog.test.ts` gets generation-stability tests (same input → same hash; mutation → different hash).
- [ ] Test: `handler.test.ts` covers role rejection, full-fetch path, cheap-refetch path with matching generation.

## 3. dryRunSupported metadata on tool definitions

Tools that honor `params.dryRun` need to advertise it. Currently this is implicit: handlers in `src/agents/tools/handlers.ts` either accept `dryRun` or they don't.

**Files:**
- `src/agents/tools/types.ts` — `ToolDefinition:42` adds `dryRunSupported: boolean` field.
- `src/agents/tools/builtins.ts` — set `dryRunSupported: true` for the four tools that currently honor it: `file_move`, `file_copy`, `file_write`, `shell`. (Confirmed in checklist.txt §4.8.)
- `src/agents/tools/invoke.ts` — already accepts `dryRun` semantics from the validated invocation; no change needed in the executor itself.

**Tasks:**
- [ ] Add `dryRunSupported: boolean` to `ToolDefinition`.
- [ ] Set the flag on the four built-in tools that honor dry-run.
- [ ] Default `false` for every other registered tool (linter rule or schema default).
- [ ] Reject `tool.invoke` with `params.dryRun: true` against a tool where `dryRunSupported === false`. Error: `DRY_RUN_NOT_SUPPORTED`.
- [ ] Test: `invoke.test.ts` confirms the rejection path; existing dry-run tests in `builtins-dryrun.test.ts` confirm the flag-true tools still work.

## 4. tools.changed event

Hint event fired when the catalog generation bumps. v1.1 has limited catalog-mutating events: agent reload (config change), hook-registered tool additions (Phase 3 hooks subsystem). Skill loads do *not* currently add tools — skills are prompt/instruction packs in `src/skills/`. The `skill_loaded` cause stays in the schema for forward-compat but won't fire from v1.1 code.

**Files:**
- `src/gateway/ws/protocol.ts` — `toolsChangedEventSchema`, `makeToolsChangedEvent` helper.
- `src/agents/tools/catalog.ts` — emit a generation-bump signal whenever the catalog mutates. Cleanest shape: an `EventEmitter`-style `onGenerationChanged(listener)` registration.
- `src/gateway/ws/handler.ts` — on connect (shell role), subscribe to catalog generation changes; on close, unsubscribe.

**Tasks:**
- [ ] Define `toolsChangedEventSchema` and `makeToolsChangedEvent` in `protocol.ts`.
- [ ] Add `onGenerationChanged(listener: (gen: string, cause: Cause) => void): UnsubscribeFn` to `ToolCatalog`.
- [ ] Wire generation-bump emission at the two real call sites: agent reload (wherever `loadConfig` reseats the agent registry) and hook-registered tool additions in `src/agents/tools/hooks.ts` if/when those happen.
- [ ] Coalesce: a debounce wrapper that holds bumps for ~100ms and fires once with the final generation.
- [ ] In `attachMessageHandler`, on `callerRole === "shell"`, subscribe; in `ws.on("close")`, unsubscribe.
- [ ] Test: `catalog.test.ts` confirms the listener fires once per coalesce window.
- [ ] Test: integration test in `handler.test.ts` confirms a shell connection receives `tools.changed` after a simulated catalog mutation.

## 5. Catalog generation hash exposed at connect

Already covered in §0 prerequisites — flag here for completeness.

**Tasks:**
- [ ] Connect response includes `catalogGeneration: string` when role is shell. (Implemented as part of §0 + §2.)
- [ ] Test: handshake.test.ts confirms the field is present for shell, absent for model_proxy.

## 6. Confirmation token store

New piece of in-process infra. Tracks pending confirmations with TTL and single-use semantics.

**Files:**
- `src/agents/tools/confirmation-tokens.ts` — new file.
- `src/gateway/ws/handler.ts` — `handleToolInvoke` consults the store on the confirmation gate path.

**Shape:**
```ts
interface ConfirmationTokenStore {
  mint(invocation: ValidatedInvocation, sessionKey: string): string;
  consume(token: string, sessionKey: string): ValidatedInvocation | "expired" | "invalid";
}
```

`consume` is single-use: a successful consume removes the entry. `expired` is returned when the entry was found but past its 60-second TTL (separate code path so the handler can return `CONFIRMATION_TOKEN_EXPIRED` instead of `CONFIRMATION_TOKEN_INVALID`).

**Tasks:**
- [ ] Implement the store with a `Map<string, { invocation, sessionKey, expiresAt }>` and a periodic sweep (every 30s) that drops expired entries.
- [ ] Tokens are crypto-random (32 bytes hex from `crypto.randomBytes(16)`) and scoped to the minting session. A different session attempting to consume returns `invalid`.
- [ ] Wire the store as a singleton in the gateway initialization.
- [ ] On the `handleToolInvoke` path:
  - If the validated invocation's effect class is in `confirmEffects` and `params.confirmationToken` is undefined, mint and return `CONFIRMATION_REQUIRED` with the token in the error payload.
  - If `params.confirmationToken` is present, consume it. On `"expired"` return `CONFIRMATION_TOKEN_EXPIRED`. On `"invalid"` return `CONFIRMATION_TOKEN_INVALID`. On a `ValidatedInvocation` return value, sanity-check it matches the current invocation (toolId + arguments) and proceed to `executeValidatedTool`.
- [ ] Test: `confirmation-tokens.test.ts` covers mint+consume happy path, expiry path, cross-session rejection, double-consume rejection.
- [ ] Test: `handler.test.ts` covers the three-step flow (invoke → CONFIRMATION_REQUIRED → invoke-with-token → success).

## 7. Error codes

All v1.1 error codes added to a single source-of-truth file so future amendments don't drift.

**Files:**
- `src/gateway/ws/error-codes.ts` — new file (or extension of an existing constants module). Export each code as a const string.

**Tasks:**
- [ ] Define and export: `ROLE_NOT_PERMITTED`, `TOOL_INVOKE_REQUIRES_SHELL_ROLE`, `TOOL_NOT_FOUND`, `TOOL_DENIED_BY_EFFECT`, `INVALID_TOOL_ARGUMENTS`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_TOKEN_EXPIRED`, `CONFIRMATION_TOKEN_INVALID`, `DRY_RUN_NOT_SUPPORTED`, `CATALOG_GENERATION_MISMATCH` (reserved).
- [ ] Replace any inline string literals in handler.ts with imports from this file.
- [ ] Lint rule (eslint-style or a simple grep-based test): error codes must match `^[A-Z][A-Z0-9_]*$` (SCREAMING_SNAKE_CASE).
- [ ] Test: a single test enumerates the constants and asserts the regex.

## 8. Documentation updates

The protocol amendment landing changes the surface area; downstream docs need to reflect that.

**Tasks:**
- [ ] `crabmeat/README.md` — add a one-paragraph note in the protocol section pointing to `PROTOCOL.md` as the canonical spec, and naming v1.1 as the current version.
- [ ] `deploy/README.md` — same paragraph mirrored for the public release tree.
- [ ] `deploy/CONTRACT.md` — cross-reference: tool handlers added in the future MUST set `dryRunSupported` accurately and MUST honor the `dryRun` parameter when set.
- [ ] `crabmeat/SECURITY.md` — add a paragraph in the threat-model section explaining why `tool.invoke` is shell-only: capability ID indirection is the boundary that protects against jailbroken LLMs, and bypassing it for non-LLM callers is correct because they aren't subject to the same trust assumption.
- [ ] `crabmeat/checklist.txt` — add a Phase 4.13 (or appropriate slot) line referring to this implementation doc, gated as a pre-Phase-5 item per the boundary-stability argument.

## 9. Known limitations and deferred items

Things not in this punchlist on purpose. Listing them here so they don't get forgotten.

- **`external` role not implemented.** Connect attempts with `callerRole: "external"` are rejected at handshake. Implementing the role requires a separate design exercise (per-external-client policy, scoped tool subsets, rate limits beyond the existing per-connection limiter, sandboxing decisions). v1.1 reserves the slot in the schema; v1.2+ may implement it.
- **`CATALOG_GENERATION_MISMATCH` not emitted.** The error code is in the schema but never returned. Optimistic concurrency on `tool.invoke` (caller passes a `generationHint` and we reject if the catalog has shifted) is not implemented because the realistic failure rate is low. Adding it later is non-breaking.
- **Skill-load catalog mutations.** Skills in `src/skills/` are currently prompt/instruction packs and don't add tools to the catalog. The `tools.changed` event's `cause: "skill_loaded"` value is in the schema for forward-compat but won't fire from v1.1 code. If a future skill format adds tools, this is the hook to use.
- **Catalog row size.** `parametersSchema` and `outputsSchema` are JSON Schema serializations of the underlying zod schemas. For tools with large schemas, this can produce sizeable rows. v1.1 does not paginate `tools.list`; if a future agent's catalog grows past ~100 tools or ~500 KB serialized, pagination becomes worth designing. Out of scope for v0.1.0.
- **Subscription model for tool execution events.** The current `tool.execute` events are tied to the originating session. A future "watch all tool executions on this gateway" subscription (for monitoring UIs) would be a new method (`events.subscribe`) and is not in scope.

## 10. Order of operations

For an implementer working through this:

1. §0 + §7 first — role state and error codes are pre-work for everything else.
2. §3 + §6 — `dryRunSupported` field and the confirmation token store are dependencies of §1.
3. §1 — `tool.invoke`. End-to-end with tests before moving on.
4. §2 + §5 — `tools.list` and the connect-response generation field. Both depend on the catalog row schema being defined.
5. §4 — `tools.changed` event. Depends on §2's generation hash.
6. §8 — documentation. Last because earlier work might surface things worth noting.

A linear pass through this is roughly two days of focused work plus a day of test coverage. The longest single task is §1 (`tool.invoke`) at maybe four hours including tests; the rest are smaller.
