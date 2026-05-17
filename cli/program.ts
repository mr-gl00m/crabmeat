import { Command } from "commander";
import { runGateway } from "./run.js";
import { startChat } from "./chat.js";
import { runSetup } from "./setup.js";
import { runDoctorCli } from "./doctor.js";
import {
  runPauseCli,
  runResumeCli,
  runFeatureCli,
  runFeatureListCli,
} from "./feature.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("crabmeat")
    .description("CrabMeat — Natural Language Computing Framework")
    .version("0.1.0");

  // ── run ─────────────────────────────────────────────────
  program
    .command("run")
    .description("Start the gateway server")
    .option("-c, --config <path>", "Path to config file")
    .action(async (opts: { config?: string }) => {
      await runGateway({ config: opts.config });
    });

  // ── chat ────────────────────────────────────────────────
  program
    .command("chat")
    .description("Interactive chat session (connects to running gateway)")
    .option("-u, --url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:3000")
    .option("-t, --token <token>", "Auth token (or set CRABMEAT_TOKEN env)")
    .option("--channel <id>", "Channel ID for routing")
    .action(async (opts: { url?: string; token?: string; channel?: string }) => {
      await startChat(opts);
    });

  // ── setup ──────────────────────────────────────────────
  program
    .command("setup")
    .description("Interactive first-run setup wizard")
    .action(async () => {
      await runSetup();
    });

  // ── doctor ─────────────────────────────────────────────
  // Standalone (no gateway) config + release-gate validation. The
  // `--strict` flag promotes warnings to errors and runs the
  // release-gate checks (auth=none, missing token, non-loopback bind
  // without TLS, admin without publicBaseUrl when external connectors,
  // webhooks without secrets). Phase 4.18.2.
  program
    .command("doctor")
    .description("Validate config and run release-gate checks (no gateway)")
    .option("-c, --config <path>", "Path to config file")
    .option("--strict", "Promote warnings to errors and run release-gate checks", false)
    .option("--gate", "Run the greenlight composite go/no-go check (pause + circuit-breaker + providers)", false)
    .action(async (opts: { config?: string; strict?: boolean; gate?: boolean }) => {
      const code = await runDoctorCli(opts);
      process.exit(code);
    });

  // ── pause / resume / feature ───────────────────────────
  // File-based feature toggles (Phase 4.19 B2). Toggles live as JSON
  // files under <workspace>/.crabmeat/features/<name>.json — atomic
  // writes, picked up by every component on its next tick. The agent
  // does not need to be running for these commands to take effect;
  // they're plain file writes.
  program
    .command("pause")
    .description("Engage the global pause toggle (blocks all inference)")
    .option("-r, --reason <text>", "Why the pause was engaged (recorded in the toggle file)")
    .action(async (opts: { reason?: string }) => {
      const code = await runPauseCli(opts);
      process.exit(code);
    });

  program
    .command("resume")
    .description("Disengage the global pause toggle")
    .action(async () => {
      const code = await runResumeCli();
      process.exit(code);
    });

  program
    .command("feature <name> <state>")
    .description("Engage (on) or disengage (off) a feature toggle by name")
    .option("-r, --reason <text>", "Why the toggle was engaged (recorded in the toggle file)")
    .action(async (name: string, state: string, opts: { reason?: string }) => {
      if (state !== "on" && state !== "off") {
        process.stderr.write(`crabmeat feature: <state> must be 'on' or 'off' (got '${state}')\n`);
        process.exit(2);
      }
      const code = await runFeatureCli({ name, state, reason: opts.reason });
      process.exit(code);
    });

  program
    .command("features")
    .description("List currently engaged feature toggles")
    .action(async () => {
      const code = await runFeatureListCli();
      process.exit(code);
    });

  // ── Default: show help with styled output ───────────────
  program.action(() => {
    program.outputHelp();
  });

  return program;
}
