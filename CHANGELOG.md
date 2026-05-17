# Changelog

All notable changes to CrabMeat are documented here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/).

When the next release is tagged, the `[Unreleased]` heading below will be
renamed to `[X.Y.Z] - YYYY-MM-DD` and a fresh `[Unreleased]` section opened
above it. The link references at the bottom of the file will be updated
to match.

## [Unreleased]

_Nothing yet; first post-release changes land here._

## [0.1.0] - 2026-05-18

Initial public release. The bullets below describe what's in v0.1.0, not
a diff against a prior version, since there isn't one. Items are grouped by
subsystem rather than chronology.

### Highlights

- Initial public release of CrabMeat: a security-first agentic gateway where
  dangerous tool classes are off by default, the always-on protections cannot
  be disabled, and the LLM never holds the security boundary.
- Ships as a single portable `CrabMeat.exe` — a PySide6 setup wizard and
  dashboard that installs and runs CrabMeat with no preinstalled Node or Python.
- Bidirectional email agent: drive CrabMeat from your inbox with
  markdown-rendered replies, thread preservation, forward / CC / reply
  handling, and outbound attachments.

### Added — gateway

- WebSocket gateway with timing-safe token auth, origin check, RFC 6455
  handshake validation, and frame size caps (64 KB pre-auth, 1 MB post-auth).
- HTTP security headers on every response (CSP, X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy).
- Health endpoint (`/health`) and readiness endpoint (`/ready`).
- Cron + webhook scheduler with per-route secret validation and a persistent
  schedule store.

### Added — inference + providers

- Multi-provider streaming: Anthropic, OpenAI, and any OpenAI-compatible
  endpoint (Ollama, LM Studio, vLLM) with an ordered failover chain that
  distinguishes model-level from provider-level errors.
- Routing:
  - **Arbiter intent gate** — the intent classifier that sits ahead of
    the persona-bearing context window. Verdicts enter the
    audit chain alongside tool calls.
  - **Layer 2** — local-model disambiguation for medium-confidence queries.
    Streaming lead-buffered escalation detection prevents the user from
    seeing a hedge token before Layer 3 takes over. Opt-in. No tool access.
  - **Layer 3** — full provider with tool calling, refusal interception,
    and content-class-gated reroute to a local fallback.
- Context compaction with a deterministic metadata header (code-generated,
  tamper-evident) plus an LLM summary body. Compaction-start and
  compaction-fallthrough diagnostic events fire so a UI can surface the
  pause without log-grepping.

### Added — tools

- 30+ built-in tools across read / write / exec / network / none effect
  classes. Highlights: `file_read` / `file_write` / `file_edit` /
  `file_move` / `file_copy` / `file_list` / `glob_search` / `grep_search` /
  `shell` / `web_fetch` / `web_search` / `weather` / `pdf_extract` /
  `browser` / `memory_*` / `timer` / `random` / `ask_user` / `todo_write` /
  `message_send` / `subagent_spawn` / `plan_mode` / `email_attach*` /
  bulk-rename utilities / `identity_*` / `notes_*` / `user_profile_*` /
  `tasks_manage` / `schedule_*`.
- Effect-classified execution: every tool call goes through six fixed-order
  deterministic checks before reaching the handler.
- Per-session HMAC-derived capability IDs: the model sees opaque
  `cap_xxxxxxxx` strings, never the real tool name.
- Workspace-jailed file tools, denylisted shell with output cap and CWD
  lock, SSRF-protected `web_fetch` (blocks cloud metadata, link-local,
  RFC1918 unless explicitly whitelisted).
- Subagent budgets: max 5 turns, 60 s wall-clock, depth 1, fresh per-tool
  rate limiter, scoped context (no parent transcript access).
- Plan mode as a runtime gate (not a prompt rule): the model cannot bypass
  by ignoring instructions.
- Dry-run mode on every destructive tool (`file_move`, `file_copy`,
  `file_write` overwrite, `shell`) plus threshold-based auto-preview for
  bulk operations.
- Owner-only tool routing: the catalog filters owner-only tools from
  non-owner callers, and validate-time gates reject any cap-ID that resolved
  despite a non-owner role.

### Added — security primitives

- Tamper-evident SHA-256 hash-chained audit log with optional disk
  persistence (atomic rename) and `verify()`. Privileged operations
  (`/admin/circuit-breaker`, `/admin/kill`, kill-token redemption,
  scheduler cron runs) record into the same chain as tool calls.
- `AuditLog.getStatus()` exposes pendingWrites / lastFlushOk / lastFlushAt /
  lastFlushError so an operator surface (`/doctor`) can detect silent
  persistence failures.
- IRONCLAD_CONTEXT pinned at the top of every context window with
  per-session canary tokens and history-trust reinforcement. Canaries are
  detected at the output stream.
- Recursive input normalization: Base64, ROT13, hex, leetspeak, homoglyphs,
  invisible Unicode, all decoded before user input reaches the context
  window.
- Streaming output leak filter: capability IDs, `sk-*`, `ghp_*`, `xoxb-*`,
  Bearer tokens, JWT-shaped strings all redacted across token boundaries.
- Refusal interception with content-class-gated reroute and a streaming
  lead buffer that captures the first 200 bytes, decides, and either
  commits to passthrough or swallows.
- Per-deployment cap secret persisted on first run; documented rotation
  procedure (`delete .crabmeat/cap-secret and restart`).
- Secret reference resolution: `$SECRET:NAME` resolved at the execution
  boundary; real values never enter the model context or transcript.
- Circuit breaker: manual trip via `/kill`, `--killbot`, admin endpoint,
  or kill-token redemption. Auto-trip on anomaly accumulation (sliding
  window).
- Kill tokens: every outbound message to an external channel embeds a
  single-use 1-hour kill URL.

### Added — connectors

- IMAP + SMTP email connector with bidirectional flow, markdown rendering
  (multipart/alternative with strict sanitize-html allowlist), per-thread
  session keys for tenant isolation, forward / CC / reply detection
  (subject prefix + unambiguous body markers), localized reply-prefix
  normalization (Re:, AW:, Antw:, SV:, VS:, Odp:, Ответ:), subject-derived
  attachment filenames, paragraph-boundary preview for long responses, and
  outbound attachment staging (`email_attach`, `email_attach_content`).
- Inbound + outbound connector registry with a failure ring buffer
  surfaced into agent context, kill-token embedding on every external
  send, and per-connector retry semantics.

### Added — agent identity + memory

- Soulshard system: declarative identity in portable `.shard` ZIP files
  (manifest with checksums, `soulshard.json`, `mindshard.json`,
  Zod-validated schemas covering personality, traits, communication style,
  boundaries, content avoidances, interaction model, can-refuse-commands).
- Seed-`AGENT.json`-on-first-load semantics: the agent's locally-evolved
  state accumulates and isn't clobbered by re-seeding.
- Memory layer with cortex tiers (STM / LTM / Core), cortexdream
  consolidation, and atomic memdir shard writers.

### Added — observability

- OTEL diagnostics boundary with a typed event contract (`tool.execution.*`,
  `model.call.*`, `context.assembled`, `message.delivery.*`,
  `memory.pressure`, `audit.recorded`, `compaction.*`,
  `telemetry.exporter`).
- Optional OTLP exporter (traces + metrics) with redaction at the export
  boundary, GenAI semantic-convention histograms (token usage, operation
  duration), and silent no-op when no endpoint is configured.
- Cost tracker: per-provider / per-model pricing, dedup of unpriced
  models, per-session totals.
- `/doctor` diagnostic command surfacing audit-flush health, provider
  connectivity, Layer 2 health, session sizes, schedule validity, disk
  usage.

### Added — operator surface

- First-run setup wizard (`crabmeat setup`) guiding provider, local-model,
  and auth configuration.
- Chat CLI with `/help`, `/status`, `/compact`, `/model`, `/doctor`,
  `/identity`, `/sessions`, `/schedules`, `/kill`, `/reset`, numeric
  `/model` presets, and badge prefixes for layered routing.
- File-based feature toggles in `.crabmeat/features/<name>.json` driving
  `crabmeat pause` / `crabmeat resume` / `crabmeat feature <name> on|off` /
  `crabmeat features` for operator control without restart.
- `crabmeat doctor` and `crabmeat doctor --strict` standalone CLI
  subcommands for pre-start operator validation and CI release gating.
  `crabmeat doctor --gate` runs the greenlight composite (pause toggle,
  circuit breaker, providers reachable) and exits 0/1 accordingly.
- `GET /greenlight` HTTP route (auth-gated when admin auth is configured)
  exposing the same composite check for external monitoring.

### Added — launcher

- Single-file `CrabMeat.exe` launcher (PySide6): a setup wizard on first run,
  an operations dashboard on every run after. End users need no preinstalled
  Node or Python.
- Setup wizard: install-folder validation (ASCII path, rejects network shares
  and OneDrive), AI-provider selection (Anthropic, OpenAI, DeepSeek, or a local
  model via Ollama), optional Gmail connection (address + App Password) for the
  email channel, and automated provisioning — copies the CrabMeat source,
  downloads a Node 22 runtime, generates `.env` / `crabmeat.json` /
  `.crabmeat/local.json`, runs `npm install`, and builds. The local-model path
  also installs Ollama and pulls the chosen model.
- Dashboard for every run after setup: launch CrabMeat (gateway + chat),
  repair / reinstall, and uninstall / reconfigure.
- Reproducible release build via `build/assemble_release.py`, which stages a
  clean CrabMeat payload (no `node_modules`, `.crabmeat`, or `.git`) into the
  packaged exe.

### Security

- Single-source audit chain. Privileged ops (admin endpoints, kill-token
  redemption, scheduler runs) enter the same SHA-256 chain as agent tool
  calls: the chain is one queryable record, not three scattered log
  surfaces.
- Webhook secret comparison hashes both inputs before timing-safe equal,
  matching the rest of the codebase's secret-compare discipline. No
  length-leak shortcut.
- Setup wizard secret prompt detects TTY availability before raw-mode
  masking; falls through to a visible-input warning when raw mode is
  unavailable rather than echoing the secret silently.
- Retry backoff carries 10–25% random jitter to prevent synchronized retry
  storms when many clients hit the same provider rate limit.

[Unreleased]: https://github.com/mr-gl00m/crabmeat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mr-gl00m/crabmeat/releases/tag/v0.1.0
