# CrabMeat Security

CrabMeat is built ground-up as a locally-hosted gateway for agentic LLM workloads. Security is not a layer bolted on top; it is the design thesis. This document describes the threat model, the defensive primitives, and how to deploy safely.

## Threat model

### In scope

- **Prompt injection from retrieved content.** A webpage, file, or tool output tries to hijack the agent into performing actions the user did not request.
- **Output exfiltration.** The model is tricked into emitting secrets (API keys, tokens, private keys, internal capability identifiers) into its response stream.
- **Tool-capability abuse.** A compromised or adversarial model tries to call tools outside its agent's declared effect classes, or to escape the file-access allowlist.
- **Runaway cost / infinite loops.** A model burns turns in a tight loop, spawns unbounded subagents, or sustains tool calls without converging.
- **Unauthenticated gateway access.** A process on the same host, or a cross-origin browser request, tries to connect to the WebSocket gateway.
- **Cross-session data access.** A connected client tries to read a session, transcript, or audit log it does not own.

### Out of scope

- **Malicious local user.** CrabMeat assumes the user running the process is trusted. Config files, `.env`, session storage, and audit logs are protected by filesystem permissions only.
- **Compromised allowlisted email sender.** The email-imap connector authenticates inbound mail by matching the parsed `From:` header against `allowFromAddresses`. RFC 5322 `From:` is not authenticated by IMAP; the connector trusts the receiving MTA's verdict. As a defense-in-depth measure, mail from an allowlisted sender that the upstream MTA hard-fails on SPF/DKIM/DMARC (`Authentication-Results: ... fail`) is dropped, which catches obvious header spoofs from outside the allowlisted account. It does NOT defend against the case where an attacker controls the allowlisted account itself; kill-switch + tool access for that account are out of scope.
- **Scoped host file access.** File tools are jailed to the workspace plus explicitly configured roots. `fileAccessPresets` grants only concrete home subfolders such as Downloads/Documents/Desktop; `fileAccessPaths` requires absolute subdirectories. Drive roots, filesystem root, home itself, bare UNC shares, relative paths, and traversal segments are rejected at config load. The `shell` tool's optional `cwd` is checked against the same roots; it does not grant host-wide execution.
- **Host-level compromise.** If the host is rooted, CrabMeat cannot defend itself.
- **Model provider trust.** If you point CrabMeat at a hosted model provider, your prompts and tool outputs leave the machine. Use local providers (Ollama, llama.cpp) when that matters.
- **Denial-of-service from a trusted client.** Rate limits are per-connection, not global. A connected client can exhaust its own budget; guarding against that is hygiene, not security.

## Defensive architecture

### 1. Capability ID indirection

Tool names are never placed in the model context directly. At session start, the runtime calls `mintCapabilityMap(sessionKey)`, which for each registered tool computes:

```
capId = HMAC-SHA256(capSecret, sessionKey || toolId) → "cap_" + first 12 hex chars
```

The model sees capability IDs (e.g. `cap_a4f9e2b71c83`); the runtime maps them back to real tool names at the execution boundary. Capability IDs are per-session and per-deployment; a leaked ID from one session cannot be replayed in another, and the output leak filter blocks any `cap_[a-f0-9]{12}` pattern from appearing in the streamed response.

The per-deployment `capSecret` is persisted on first run and should be treated as a secret. Rotating it invalidates all existing capability IDs.

#### Rotating the cap secret

If you suspect the cap secret has leaked (a model output captured one in cleartext, a backup ended up somewhere it shouldn't, a contributor with access has rotated off), rotate it:

1. Stop the gateway (`Ctrl-C` the foreground process, or kill the launched server).
2. Delete `.crabmeat/cap-secret`. (Path is workspace-relative on default config; check `paths.dataDir` if you've overridden it.)
3. Restart the gateway. A new secret is minted on first run.

The rotation invalidates every previously minted cap ID. Active sessions will mint fresh IDs on their next tool-call cycle; there is no online migration. Any persisted cap ID in a long-running queue or audit-log fixture stops resolving after rotation; that is the expected behavior, not a bug. The audit chain itself is unaffected because audit entries store tool ID and effect class, not cap ID.

### 2. Effect classes

Every tool declares an `effectClass` in config: `read`, `write`, `exec`, `network`, or `privileged`. Each agent declares `allowedEffects`. A tool invocation is validated before execution:

- The capability ID must map to a real tool.
- The tool's effect class must be in the calling agent's `allowedEffects`.
- `privileged` is an explicit opt-in; agents do not inherit it.

`validateToolInvocation` is a pure function with no runtime state, which makes it simple to reason about and to test exhaustively.

### 3. Plan mode

`plan_mode` is a Claude-Code-style read-only checkpoint. When an agent calls `plan_mode(action="enter")`, the runtime sets a per-session flag. While active, `isEffectBlockedByPlanMode` denies any tool call whose effect class is `write`, `exec`, or `network`, with a clear error directing the agent to call `plan_mode(action="exit", plan={...})` first.

Exiting requires a structured plan: `{goal, steps[{id, tool, inputs, outputs?, depends_on?, tier?}], confidence}`. The plan is validated for shape, duplicate step IDs, and forward-reference dependencies, then cached on the session and surfaced to the user for approval.

Plan mode is opt-in per turn; the agent decides when to enter it. For deployments that require a plan for every non-trivial action, configure the agent's system prompt accordingly.

### 4. Subagent budgets

`subagent_spawn` launches a child inference with hard, non-configurable caps:

- **Max turns:** 5 (default 3)
- **Max wall-clock:** 60 seconds (default 30)
- **Depth:** 1. Children cannot spawn grandchildren; `subagent_spawn` is filtered out of the child's tool list.
- **Scoped context:** the child sees only `task` + optional `context`, never the parent transcript.
- **Fresh rate limiter:** the child gets its own per-tool budget, so a parent cannot exhaust its limits via children.
- **Inherited audit:** child audit entries derive from the parent's session key (`${parentKey}::sub::${uuid}`), so the full call chain is reconstructible.

Wall-clock is enforced with `Promise.race` against a `setTimeout` that resolves to an error, recomputed each iteration against an absolute deadline.

### 5. Secret indirection

Tool parameters can reference secrets as `$SECRET:NAME`. These are resolved at the execution boundary by the default env-backed `SecretStore` (`process.env[NAME]`) and are never serialized into the model context. The agent sees the reference; the tool handler sees the resolved value.

Secrets live in `.env` (gitignored). See `.env.example` for the convention.

### 6. Output leak filter

Before streaming model output to the client, `sanitize.ts` matches against a set of high-confidence secret patterns:

- Capability IDs (`cap_[a-f0-9]{12}`)
- OpenAI keys (`sk-...`)
- GitHub PATs (`ghp_...`)
- Slack tokens (`xoxb-...`, `xox[pboa]-...`)
- AWS access keys (`AKIA...`)
- JWT tokens
- Password assignments (`password=...`)
- Connection strings (`postgres://...`, `mongodb://...`, etc.)
- PEM private key headers
- Internal trust-boundary tags (`SIGIL_TRUST_BOUNDARY`, `IRONCLAD_CONTEXT`)

Matches are redacted or the message is dropped, depending on sink policy. The filter runs after NFKC normalization and zero-width stripping to defeat homoglyph bypass.

### 7. Gateway authentication

The WebSocket gateway supports three auth modes:

- **`token`** (default, recommended): 32+ character shared secret; checked with constant-time comparison (`secretEqual`).
- **`password`**: 12+ character password.
- **`none`**: for unit tests only. Do not use in real deployments.

Additional gateway defenses:

- **Origin allowlist.** WebSocket upgrade requests are rejected if the `Origin` header is not in `gateway.origins`. **Scope:** the Origin check defends against browser-initiated cross-site WebSocket hijack (CSWSH). Non-browser clients (CLI, native apps, scripts) commonly omit `Origin` and the check returns "allowed" by design; for those clients the actual access control is `gateway.auth.token`. Do not treat the Origin allowlist as defense-in-depth for non-browser callers; treat it as exactly what it is, a CSWSH guard. RT-2026-04-30-011.
- **Host binding.** Default bind is `127.0.0.1`. Do not expose the gateway to the network without TLS and a real reverse proxy.
- **Rate limits.** Post-auth message flooding is capped per-connection; clients exceeding the threshold are disconnected.
- **Cross-session isolation.** Ownership is checked on every transcript/audit read; a session key from client A cannot access session B.
- **Session-key secret.** `deriveSessionKey` HMACs `(agentId, channelId, peerId)` with a per-deployment secret persisted at `.crabmeat/session-key-secret`. Without this, the HMAC key was a hardcoded string and any token-holder could compute another holder's session keys for the same routing tuple. The secret is minted on first run alongside `cap-secret` and should be backed up + permission-restricted the same way.

**Single-token auth means single-user.** `gateway.auth.mode = "token"` provides ONE shared secret. Anyone with the token is treated as the same user; there is no per-user identity binding inside the gateway. Multi-user deployments must front the gateway with a TLS-terminating reverse proxy that asserts identity via a header, and use a deployment topology that derives sessionKeys per asserted identity (out of scope for the current single-binary design).

### 8. File access allowlist

The `fileAccessPaths` config field is the only way file-tools (`file_read`, `file_write`, `file_list`, `glob_search`, `grep_search`, `file_edit`, `file_move`, `file_copy`) can reach the filesystem. Paths are resolved absolute and checked against the allowlist at invocation time; traversal (`..`) and symlink-escape are rejected before the tool handler runs.

### 9. Arbiter intent gate

A deterministic intent-extraction stage sits in front of the inference loop. When the user's input matches a known intent shape (`file_read`, `file_write`, `web_search`), the arbiter stage handles the turn end-to-end without invoking the model; the model is consulted (a single short call) but does not drive execution. Anything that doesn't match a known intent falls through to the regular inference path.

This stage replaces the older Layer 0 pattern-matching dispatcher (deleted in Phase 5). The `layer0.*` config block, if present, is silently ignored; do not configure tools through it expecting allowlist semantics. Effect-class enforcement remains the load-bearing access control regardless of which path a turn takes.

## Error & surface contract

Silent failures are a security posture issue as well as a UX issue; a tool that swallows its own failure teaches the agent to lie about its own capability. The rules every tool, connector, and scheduler job in CrabMeat follows (error shape, connector failure surfacing, scheduler `lastStatus` / `lastError`, provider failover exhaustion) are documented in [CONTRACT.md](../deploy/CONTRACT.md). New components added to the codebase must conform.

## Secure deployment checklist

- [ ] `.env` exists, is gitignored, and contains a freshly-generated `CRABMEAT_TOKEN` (min 32 chars, cryptographically random).
- [ ] `CRABMEAT_ADMIN_TOKEN` is set if `admin.enabled = true`.
- [ ] `gateway.host` is `127.0.0.1` unless you are fronting with a real TLS-terminating proxy.
- [ ] `gateway.origins` is set to the exact origins you expect (not `*`).
- [ ] `gateway.auth.mode` is `token` or `password`, never `none`.
- [ ] Each agent's `allowedEffects` is the minimum set needed for its purpose. Avoid `privileged` unless required.
- [ ] `fileAccessPaths` lists only the directories the agent should be able to reach. Do not list `/` or `C:/`.
- [ ] `allowLocalProviders` is `true` only if you want to connect to local model servers (Ollama, llama.cpp).
- [ ] The per-deployment `capSecret` file is backed up somewhere safe and has restrictive filesystem permissions.
- [ ] `doctor` reports no warnings: `node dist/entry.js doctor`.
- [ ] Full test suite passes: `npx vitest run`.

## Reporting vulnerabilities

CrabMeat is under active development and has not been formally audited. If you find a vulnerability:

1. **Do not open a public issue.** Please report privately.
2. Send details to the maintainer via the repository's configured private channel.
3. Include a minimal reproducer, the affected version/commit, and your assessment of impact.
4. Expect an initial response within a reasonable timeframe; please allow time for a fix before public disclosure.

Coordinated disclosure is appreciated. Researchers acting in good faith will not be pursued.
