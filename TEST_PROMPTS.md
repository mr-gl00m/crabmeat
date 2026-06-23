# CrabMeat Test Prompts

A set of realistic prompts for exercising tool combinations end-to-end. Copy one into the chat and watch the audit log / console to verify the expected tools fire in the expected order.

Each entry lists: the prompt, the tools it should touch, and what to watch for.

---

## 1. Web research + remote delivery

> Give me the latest news about Pokémon competitive, leaving for a while — shoot me a Discord message when you're done.

**Exercises:** `web_search` (or `browser` + `get_text`), `message_send` (discord connector), source citation.
**Watch for:** agent finishes with `message_send` to Discord, *not* just a chat-window summary. Final summary cites source URLs (new CITE YOUR SOURCES clause). Kill-link embedded in the Discord message.

---

## 2. Plan-mode gated refactor

> I want you to add a `--verbose` flag to the `doctor` command. Enter plan mode first, show me the plan, and only touch files after I approve.

**Exercises:** `plan_mode(enter)`, read tools (`grep_search`, `file_read`), `plan_mode(exit, plan={...})`, then `file_edit`, `shell` (typecheck).
**Watch for:** while plan mode is active, any `file_write`/`shell`/`file_edit` call must be denied with the plan-mode error. Exit must include a structured plan object. Execution resumes only after exit.

---

## 3. Subagent fan-out research

> Compare the top three open-source vector databases — latency, license, and the weirdest limitation each one has. Use subagents to research them in parallel so your main context stays clean.

**Exercises:** `subagent_spawn` (×3), each child using `web_search` / `web_fetch`, then parent synthesis with citations.
**Watch for:** three child audit entries with session keys `${parent}::sub::${uuid}`. Each child's turn count ≤ 5 and wall-clock ≤ 60s. Parent transcript does *not* contain the children's intermediate scraping.

---

## 4. Multi-step task with todo tracking

> Walk through this repo and give me a written summary of the security architecture. Track your work with a task list so I can see what you've checked.

**Exercises:** `tasks_manage` (create_list, check), `file_list`, `glob_search`, `grep_search`, `file_read`, `memory_write` (optional).
**Watch for:** task list is created *first* with all items, then items are checked off as work proceeds. Final summary references specific files and line numbers.

---

## 5. Browser interaction

> Open hacker news, grab the top five stories, and tell me which one has the most points. Paste the URLs.

**Exercises:** `browser` (navigate, wait_for, get_text / get_links).
**Watch for:** actual navigation (not a guessed summary), real URLs pulled from the page, numeric comparison. Sources cited.

---

## 6. File edit + verify

> In `src/config/schema.ts`, find where the tool description length cap is set and tell me what it is. Don't change anything — just report the file and line.

**Exercises:** `grep_search`, `file_read`. Pure read — no writes should fire.
**Watch for:** result cites file and line number. Zero write/exec audit entries.

---

## 7. Scheduling

> Every weekday at 9am, check the top story on Hacker News and message me the headline on Discord. Show me what you've scheduled when you're done.

**Exercises:** `schedule_task` (cron), `list_schedules`.
**Watch for:** cron expression is weekday-specific (`0 9 * * 1-5`), scheduled action references the right tool chain, `list_schedules` confirms it landed.

---

## 8. Memory + user profile

> Remember that I prefer terse responses and that my main interests right now are security research and competitive TCGs. Verify it stuck by reading your notes back to me.

**Exercises:** `user_profile_update`, `user_profile_read`, possibly `notes_write`.
**Watch for:** agent writes *then* reads back — no claiming success without the verification read.

---

## 9. Shell + grep code audit

> Run the full test suite and tell me if anything is flaky. If you find a flake, grep the test file for what it's asserting and explain.

**Exercises:** `shell` (vitest), `grep_search`, `file_read`.
**Watch for:** shell output is actually parsed (not hallucinated), flake identification references a real test name from the output.

---

## 10. Ask-user clarification loop

> Clean up my Downloads folder.

**Exercises:** `ask_user` — the request is ambiguous, agent should pause and ask what "clean up" means before touching anything.
**Watch for:** agent does *not* start deleting or moving files. `ask_user` fires with a natural-language question (not numbered options — see feedback_natural_language_ux).

---

## 11. Timer + random

> Roll 4d6, drop the lowest, six times. Time how long it takes you to do the whole thing and tell me the elapsed ms.

**Exercises:** `random` (dice mode, ×6), `timer` (start, stop).
**Watch for:** real dice rolls via the tool (not self-picked numbers), real elapsed time from the timer, not an estimate.

---

## 12. Identity / self-awareness

> What's your name? If you don't have one, pick one and remember it.

**Exercises:** `identity_read`, `identity_update`.
**Watch for:** agent reads its identity first, only writes if no name is set, and persists through a restart.

---

## Running them

1. Start the gateway: `launch.bat` (Windows) or `node dist/entry.js run` (with `.env` sourced).
2. In the chat, paste a prompt verbatim.
3. Tail the audit log / JSON console output to confirm the expected tool sequence.
4. For the Discord-delivery prompts, make sure a Discord webhook connector is configured in `.crabmeat/local.json`.
