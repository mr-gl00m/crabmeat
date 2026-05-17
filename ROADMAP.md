# CrabMeat Roadmap

What's shipping now, what's coming next, and what's deliberately out of scope.
Nothing here is a timeline promise; it's a picture of where the project is headed
and which pieces are ready to use today.

---

## Shipping now (v0.1.0)

The pieces below are working in `crabmeat/src/` and covered by tests.

### Gateway

- WebSocket server with timing-safe auth, origin check, RFC 6455 handshake validation,
  and frame caps (64 KB pre-auth, 1 MB post-auth).
- HTTP admin endpoints for circuit-breaker control and diagnostics, off by default.
- HTTP security headers on every response.
- Workspace jail on all file tools; configurable named scoped roots for expanding
  agent reach without a global YOLO switch.

### Inference

- Multi-provider streaming (OpenAI, Anthropic, OpenAI-compatible endpoints like
  Ollama / LM Studio / vLLM) with an ordered failover chain.
- Session management with JSON-backed transcripts and LLM-driven context compaction
  (deterministic metadata header + LLM summary body).
- Streaming token output with mid-stream secret-leak filter and capability-ID
  redaction.
- Per-session HMAC-derived capability IDs: the LLM never sees a real tool name.

### Routing

- **Arbiter** — the intent gate that sits ahead of the persona-bearing context
  window. Audit chain captures arbiter verdicts.
- **Layer 2 local-model routing** — confidence-band routing to a local Ollama model
  for disambiguation and simple reasoning. Opt-in. Streaming lead-buffered escalation
  detection. No tool access.
- **Refusal interception** — content-class-gated reroute to a fallback provider when
  the primary refuses, with streaming lead buffer to avoid mid-stream stutter.

### Tools

30+ built-in tools. Effect-classified, dry-run-supported, audit-logged. Full table
below. Highlights: file ops with workspace jail and dry-run, denylisted shell, web
fetch with SSRF protection, web search across multiple backends, browser automation,
PDF extraction, persistent memory, agent identity, scheduler tools, email
attachments, plan-mode DAG validation.

### Security

- Tamper-evident SHA-256 hash-chain audit log covering tool calls, privileged
  operations (admin endpoints, kill-token redemption, scheduler runs), and provider
  events.
- Recursive input normalization (Base64, ROT13, hex, leetspeak, homoglyphs,
  invisible Unicode).
- IRONCLAD_CONTEXT pinned at the top of every context window, non-compactable.
- Canary tokens for system-prompt exfiltration detection.
- Tool result trust-wrapping (`<TOOL_RESULT type="untrusted">`).
- Circuit breaker (manual trip + auto-trip on anomaly accumulation).
- Capability-secret rotation runbook in `SECURITY.md`.
- Owner-only routing for config-mutating tools.

### Connectors

- **Email** — bidirectional IMAP + SMTP with markdown rendering
  (multipart/alternative + strict sanitize-html allowlist), threading via
  `In-Reply-To` / `References`, per-thread session keys for tenant isolation,
  forward / CC / reply detection, localized reply-prefix normalization,
  subject-derived attachment filenames, paragraph-boundary preview for long
  responses, outbound attachments.
- **WebSocket** — gateway native.
- **CLI chat** — terminal interface with slash commands.

### Operator surface

- Slash commands: `/help`, `/status`, `/compact`, `/doctor`, `/sessions`,
  `/schedules`, `/kill`, `/reset`, `/model`, `/identity`.
- First-run setup wizard (`crabmeat setup`) for provider, local model, auth.
- `crabmeat doctor --strict` for release-gate validation.
- OTEL diagnostics boundary — typed event contract, optional OTLP exporter
  (traces + metrics) with redaction at the export boundary.

### Daily-driver subsystems

- **Skills** — drop-in `.crabmeat/skills/` packs with `SKILL.md` frontmatter.
  Sandboxed, subject to the same effect-class rules as built-in tools. No
  auto-fetch, no remote registry.
- **Scheduler** — cron-based and webhook-triggered task execution. Webhook secrets
  required by default. Persistent store with `lastStatus` / `lastError` per
  schedule; audit-chain entries on every run.
- **Hooks** — `before_query` / `after_tool_use` / `on_error` / `on_turn_complete`
  lifecycle handlers.
- **Agent identity** — `AGENT.json` + portable `.shard` ZIPs with manifest
  checksums, soulshard / mindshard schemas, locally-evolved state preserved
  across re-seeding.
- **Memory** — cortex-tiers (STM / LTM / Core), atomic memdir shard writers,
  cortexdream consolidation.

---

## Coming next (post-v0.1.0)

These are queued behind the v0.1.0 cut and land one at a time with their own tests
and docs, not as a single drop.

### Email coverage expansion (v0.1.1)

Outlook desktop and Apple Mail render verification. v0.1.0 ships against
Gmail-as-primary; the rendering path is the same for other clients, but
operator-side verification on each client is its own friction surface.

### Data foundation

A shared local SQLite layer (WAL, prepared statements, no ORM, forward-only
migrations, FTS5 for full-text, `sqlite-vec` for embedding search) that downstream
tracks plug into instead of each rolling its own indexed JSON. Audit chain, session
transcripts, skills, and `AGENT.json` stay JSON; they're linear append-only and
right as files. The data foundation is the substrate for relationship memory,
semantic file index, clipboard history, plural reminders, and the coding symbol /
call-graph index.

### Plan-mode DAG executor

`plan_mode` already produces validated DAG plans (goal, steps, dependency graph,
confidence). The executor that consumes a plan and runs it deterministically
(parallel execution of independent steps, output → input wiring through structured
outputs, step-level memoization, per-step retry semantics) is the missing half.

### `/admin/status` endpoint

Single GET returning structured JSON for the operator surface: audit chain head
and lag, breaker state, recent connector failures, queue depths, layer dispatch
counts, cost totals, model selector cooldown state. The data already lives in
module-level state; just needs a serializer.

### Encryption-at-rest for session transcripts

Optional XSalsa20-Poly1305 encryption keyed off a passphrase or OS keychain,
with a magic-header tag so plaintext sessions still load. Backwards compatible.

### Per-session cost cap

Configurable per-session cap (`session.costCapUsd`); warn at 80%, refuse at 100%.
Particularly relevant for unattended scheduled runs.

### Inbound webhook connector

Generic HTTP receiver with per-route secret validation, Zod schema validation,
body size cap, rate limit, and the same trust-wrapping as email inbound. Wires
into the existing routing layer.

### Content extraction tools

Web Readability port (clean text from HTML) and a local PDF document extract tool.
Both local-only, workspace-jailed.

---

## Looking further ahead

Bigger tracks that build on the v0.1.0 substrate. These are intentionally
low-resolution; what shape they take depends on what's true after the public drop
is in operators' hands. Listed for transparency, not commitment.

- **Desktop system control** — processes, GPU, thermal, displays, audio routing,
  network / VPN / DNS, peripherals + Bluetooth, power + focus, package-manager
  bridge.
- **Clipboard + file intelligence** — clipboard history + watcher, semantic file
  index over the data foundation, OCR over images, downloads-folder triage.
- **Relationship & entity memory** — person facts, entity aliases, draft-in-voice-of,
  preferred-channel routing, remind-before-meeting with relationship context.
- **Life-admin loop** — calendar (CalDAV + Gmail / Outlook OAuth bridge), plural
  reminders, inbox triage, deadline detection, daily brief generation. Inbound
  email attachment handling lives here, gated on prompt-injection defenses landing
  first.
- **Voice loop** — push-to-talk capture + local whisper.cpp STT + LLM → local
  Piper / Kokoro TTS with VAD-gated barge-in, reconnect-replay, transcript-as-JSONL.
  First-party pipeline; no provider-native streaming audio.
- **Desktop choreography** — `launch_app`, window/workspace choreography
  (yabai / komorebi / hyprctl), accessibility-tree-first GUI automation with
  `verify_action` as the anti-"lying success" primitive, vision fallback only for
  Electron / games / canvas.
- **Coding-agent tools** — scoped project memory, test-driven loop with
  `guard_tests` anti-cheat, non-blocking `spawn_process` + `wait_for_log_pattern` +
  `http_probe`, DAP debugger attach, LSP-backed refactor, hunk-level git surgery,
  semantic codebase index + call graph.
- **Framework spine** — reversibility primitives (auto-checkpoint, undo, journal),
  multi-agent (delegate, handoff, agent worktree, lock, merge), tool schema rigor
  (`reversible` + `inverse_fn` metadata, structured-tool-call repair), receipts +
  counterfactuals as a user-facing surface on the existing audit chain.
- **Smart home** — Home Assistant integration, ambiguity resolver, media routing.
- **Optional GUI frontend** — first-party desktop UI (PySide6 per house style).
  Backend stays the existing gateway; frontend is pure presentation. Optional,
  not a CLI replacement.

---

## Tools — confirmed working and planned

Source of truth for tool status. Anything marked "requested" is open for
discussion; see CONTRIBUTING.md.

### Confirmed working (shipped)

| Tool | Effect | Notes |
|---|---|---|
| `file_read` | read | Workspace jail + extra allowed paths, line offset/limit |
| `file_write` | write | Workspace jail, overwrite requires explicit flag, dry-run supported, atomic writes |
| `file_edit` | write | Surgical literal-string replace (single match by default), atomic writes |
| `file_move` | write | Workspace jail on both ends, dry-run + threshold-gated bulk |
| `file_copy` | write | Workspace jail on both ends, dry-run + threshold-gated bulk |
| `file_list` | read | Directory listing with sizes |
| `glob_search` | read | Glob pattern matching |
| `grep_search` | read | ripgrep-style content search with glob filter |
| `shell` | exec | Denylist-filtered, CWD locked, output capped, dry-run supported |
| `web_fetch` | network | SSRF-protected GET, size capped |
| `web_search` | network | Tavily / Brave / DuckDuckGo (auto-selected by configured keys) |
| `weather` | network | wttr.in plain-text reports, no API key |
| `pdf_extract` | read | Local PDF text extraction with normalization, byte-size capped |
| `browser` | network | Playwright-backed Chromium for JS-heavy pages |
| `memory_write` / `memory_read` | write / read | Persistent agent memory store, atomic writes |
| `timer` | none | Real wall-clock timing (monotonic OS clock) |
| `random` | none | OS cryptographic entropy (modes: integer / float / uuid / choice / dice) |
| `ask_user` | read | Pause mid-turn for clarification with timeout |
| `todo_write` | read | In-session planning scratchpad |
| `message_send` | network | Send to external connectors with kill-link |
| `subagent_spawn` | exec | Budgeted child inference for self-contained subtasks |
| `plan_mode` | read | Read-only checkpoint + structured DAG plan validation |
| `email_attach` / `email_attach_content` | read / write | Stage outbound email attachments |
| `identity_read` / `identity_update` | read / write | Read/update `AGENT.json` |
| `notes_read` / `notes_write` | read / write | Scratch-pad notes with tags + expiry |
| `user_profile_read` / `user_profile_update` | read / write | Observations about the user |
| `tasks_manage` | write | Persistent task lists with checkboxes |
| `schedule_task` / `list_schedules` / `cancel_schedule` | write / read | Cron job lifecycle |
| `rename_files_dirty` / `flatten_folder` / `clean_junk_files` / `rename_episodes` / `rename_rom_files` | write | Bulk filename utilities (dry-run + confirm-token gated) |

### Planned (in the internal tree, pending hardening)

| Tool | Effect | Notes |
|---|---|---|
| `secrets_lookup` | read | Explicit `$SECRET:NAME` resolver tool (resolution already runs at param-bind time; this exposes it to the agent for guarded access) |
| `task_create` / `task_get` | read/write | Subtask spawning beyond `subagent_spawn`'s scope |

### Requested (open for discussion)

This section grows as issues come in. File a request using the template in
CONTRIBUTING.md and include:

- What the tool does
- Its effect class (`read`, `write`, `exec`, `network`, `none`)
- Why the existing tools don't cover it
- What could go wrong if the LLM is compromised while holding this tool

---

## What will *not* land here

Some things are intentional omissions. These aren't "not yet"; they're "not ever,"
and the reasoning is part of the project's design.

- **Automatic full-session context handoff to other providers.** Trust-boundary
  crossing without consent, injection amplification across models, no audit trail,
  loss of context integrity. The right response to a rate limit is to wait, queue,
  or tell the user.
- **Remote skill / plugin registries that auto-install executable code.** Skills are
  files you put in your workspace. No auto-fetch, no community registry that ships
  code to your process.
- **Defaults that weaken security.** No unauthenticated mode, no "convenience"
  shell allowlists, no "just trust the LLM" tool execution. If you want any of
  those, you'll write the config yourself and own the consequences.
- **Cloud LLM providers as the default integration.** CrabMeat ships configured for
  local-first by default. Cloud providers are first-class but require explicit
  configuration; there's no "happy path" that silently sends your prompts to a
  hosted endpoint.
- **YOLO mode.** No global "trust the LLM with everything" switch. Expanded agent
  reach comes through named scoped roots (`fileAccessPresets`, `fileAccessPaths`),
  not blanket allow. Each root is explicit, audit-logged, and bounded.
- **Multi-user / RBAC.** Single operator on their own machine. The `callerRole`
  plumbing is the seam if scope ever expands; the user-management layer is
  intentionally absent.
- **Web-based admin UI.** The terminal CLI is the primary interface. An optional
  PySide6 frontend may eventually live alongside it for the operator's own use; a
  hosted web admin is a different product.

---

## How decisions get made

CrabMeat is security-first. When a feature request and a security concern collide,
the security concern wins. That's not a principle to be negotiated around; it's
the reason the project exists. A feature that can't be added safely will stay out
until it can be.

If you disagree with a decision, open an issue. The reasoning should be documented
and debatable, just not at the cost of the security posture.
