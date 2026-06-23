#!/usr/bin/env node
/**
 * bench-gui-toolcalls — pass-rate bench for candidate bundled models.
 *
 * Fires grandma-class utterances at an OpenAI-compatible chat endpoint
 * with the GUI shell's tool catalog attached, and scores whether the
 * model emitted the expected tool call with sane arguments. Converts
 * "can model X follow instructions" from vibes into a number.
 *
 * Works against any OpenAI-compatible server:
 *   - llama.cpp:  llama-server -m model.gguf -c 8192  →  http://127.0.0.1:8080/v1
 *   - Ollama:     http://127.0.0.1:11434/v1  (fine for benching — prompts
 *                 here are short, so the /v1 num_ctx truncation pitfall
 *                 that breaks real CrabMeat sessions does not bite)
 *
 * Usage:
 *   node tools/bench-gui-toolcalls.mjs --base-url http://127.0.0.1:11434/v1 \
 *        --model qwen3:4b --model gemma3:4b [--runs 3] [--verbose]
 *
 * Exit code 0 always (it's a report, not a gate). Results also written to
 * .bench/gui-toolcalls-<timestamp>.json for comparison across runs.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
function argValues(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}
const baseUrl = argValues("--base-url")[0] ?? "http://127.0.0.1:11434/v1";
const models = argValues("--model");
const runs = Number(argValues("--runs")[0] ?? "1");
const verbose = args.includes("--verbose");
const apiKey = process.env.BENCH_API_KEY ?? "bench";

if (models.length === 0) {
  console.error("Usage: node tools/bench-gui-toolcalls.mjs --base-url <url> --model <name> [--model <name2>] [--runs N] [--verbose]");
  process.exit(1);
}

// ── Tool catalog: mirrors the _agents_gui_shell_alternate surface ──
// Kept in sync with crabmeat.example.json by hand; the bench is about
// the MODEL's behavior against this exact shape, so the shape lives here
// verbatim rather than being derived at runtime.

const TOOLS = [
  {
    name: "search_files",
    description: "Find files by name or content with one plain-text query. No regex or glob syntax.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-text search query (words, not regex)." },
        path: { type: "string", description: "Base directory to search from." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "launch_app",
    description: "Open an installed desktop application by name. Pass the user's phrasing; resolution is handled for you.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "App name or the user's phrasing for it." },
        alias: { type: "string", description: "Original user phrasing to remember for this app." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "file_list",
    description: "List the contents of a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description: "Ask the user a clarifying question when their request is too vague to act on.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    description: "Recall previously saved notes and facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "memory_write",
    description: "Save a note or fact the user wants remembered.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT =
  "You are a friendly desktop assistant. Translate what the user asks into one tool call. " +
  "If the request is small talk or a greeting, just answer in text without calling any tool. " +
  "If the request is too vague to act on, use ask_user. Never invent capabilities you don't have.";

// ── Bench loop ────────────────────────────────────────────

async function callModel(model, utterance) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: utterance },
      ],
      tools: TOOLS.map((t) => ({ type: "function", function: t })),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  const msg = body.choices?.[0]?.message ?? {};
  const call = msg.tool_calls?.[0];
  return {
    tool: call?.function?.name ?? null,
    args: call?.function?.arguments ?? null,
    text: msg.content ?? "",
  };
}

function scoreFixture(fixture, result) {
  // expectTool may be a string or an array of acceptable tools (for
  // utterances where more than one response is defensible, e.g. acting
  // vs. asking a clarifying question).
  const accepted = Array.isArray(fixture.expectTool) ? fixture.expectTool : [fixture.expectTool];
  if (accepted.length === 1 && accepted[0] === "none") {
    return result.tool === null
      ? { pass: true }
      : { pass: false, why: `called ${result.tool}, expected no tool` };
  }
  if (!accepted.includes(result.tool)) {
    return { pass: false, why: `called ${result.tool ?? "no tool"}, expected ${accepted.join(" or ")}` };
  }
  // Arg expectations only apply when the primary (first-listed) tool was
  // chosen — an accepted alternate like ask_user has different args, but
  // they still must be valid JSON.
  if (result.tool !== accepted[0]) {
    try {
      JSON.parse(result.args ?? "{}");
      return { pass: true };
    } catch {
      return { pass: false, why: `unparseable tool arguments: ${String(result.args).slice(0, 120)}` };
    }
  }
  // Arguments must be valid JSON — a mangled-format model fails here even
  // when it picked the right tool. That failure mode is the whole reason
  // gpt-oss/deepseek-r1 were disqualified.
  let parsedArgs;
  try {
    parsedArgs = JSON.parse(result.args ?? "{}");
  } catch {
    return { pass: false, why: `unparseable tool arguments: ${String(result.args).slice(0, 120)}` };
  }
  const argsLower = JSON.stringify(parsedArgs).toLowerCase();
  for (const want of fixture.expectArgs ?? []) {
    if (!argsLower.includes(want.toLowerCase())) {
      return { pass: false, why: `args missing '${want}': ${argsLower.slice(0, 120)}` };
    }
  }
  return { pass: true };
}

const { fixtures } = JSON.parse(await readFile(join(here, "bench-gui-toolcalls.fixtures.json"), "utf-8"));
const report = { baseUrl, runs, startedAt: new Date().toISOString(), models: {} };

for (const model of models) {
  console.log(`\n── ${model} ──`);
  const perFixture = {};
  let passes = 0;
  let total = 0;
  for (const fixture of fixtures) {
    let fixturePasses = 0;
    const failures = [];
    for (let r = 0; r < runs; r++) {
      total++;
      try {
        const result = await callModel(model, fixture.utterance);
        const verdict = scoreFixture(fixture, result);
        if (verdict.pass) {
          fixturePasses++;
          passes++;
        } else {
          failures.push(verdict.why);
        }
      } catch (err) {
        failures.push(`request failed: ${err.message}`);
      }
    }
    perFixture[fixture.id] = { passes: fixturePasses, runs, failures };
    const mark = fixturePasses === runs ? "PASS" : fixturePasses > 0 ? "FLAKY" : "FAIL";
    if (mark !== "PASS" || verbose) {
      console.log(`  ${mark.padEnd(5)} ${fixture.id}${failures.length ? ` — ${failures[0]}` : ""}`);
    }
  }
  const rate = total === 0 ? 0 : (100 * passes) / total;
  console.log(`  pass rate: ${passes}/${total} (${rate.toFixed(1)}%)`);
  report.models[model] = { passes, total, rate: Number(rate.toFixed(1)), perFixture };
}

const outDir = join(here, "..", ".bench");
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `gui-toolcalls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(`\nReport written: ${outPath}`);
