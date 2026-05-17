/**
 * CrabMeat First-Run Setup Wizard
 *
 * Interactive CLI setup that guides the user through initial configuration.
 * Writes to user-scope config (~/.crabmeat/config.json).
 * Can be re-run at any time via `crabmeat setup`.
 */

import { createInterface, type Interface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeJsonAtomicSync } from "../infra/fs.js";
import {
  c,
  theme,
  BANNER,
  box,
  lightBox,
  separator,
  createSpinner,
  print,
  blank,
} from "./ui.js";

// ── Paths ─────────────────────────────────────────────────

const USER_CONFIG_DIR = join(homedir(), ".crabmeat");
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, "config.json");

// ── Types ─────────────────────────────────────────────────

interface SetupAnswers {
  providerType: "openai" | "anthropic" | "ollama" | "skip";
  apiKey: string;
  model: string;
  baseUrl?: string;
  localModel: boolean;
  authMode: "token" | "password" | "none";
  authToken?: string;
  authPassword?: string;
  emailEnabled: boolean;
  emailUser?: string;
  emailPassword?: string;
  emailFrom?: string;
}

// Cheap email sanity check — not RFC validation, just enough to reject a
// blank or obviously malformed entry before it reaches connector config.
function looksLikeEmail(value: string): boolean {
  const parts = value.trim().split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return (
    Boolean(local) &&
    domain!.includes(".") &&
    !domain!.startsWith(".") &&
    !domain!.endsWith(".")
  );
}

// ── Readline helpers ──────────────────────────────────────

function ask(rl: Interface, question: string, defaultVal?: string): Promise<string> {
  const prompt = defaultVal
    ? `  ${c.yellow}?${c.reset} ${question} ${c.dim}(${defaultVal})${c.reset} `
    : `  ${c.yellow}?${c.reset} ${question} `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askSecret(rl: Interface, question: string): Promise<string> {
  const stdin = process.stdin;
  // Raw-mode input masking only works on a real TTY. CI environments,
  // older Windows console hosts, certain screen/tmux configs, and piped
  // input all lack it — falling through silently would echo the secret
  // to the screen. Detect that up front and warn explicitly.
  const canMask =
    Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";

  if (!canMask) {
    const warn = `  ${theme.warn(
      "[!] No TTY available — input will be visible while you type.",
    )}`;
    print(warn);
    return ask(rl, question);
  }

  const prompt = `  ${c.yellow}?${c.reset} ${question} `;
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const oldRaw = stdin.isRaw;
    stdin.setRawMode!(true);

    let buf = "";
    const onData = (ch: Buffer) => {
      const char = ch.toString();
      if (char === "\n" || char === "\r") {
        stdin.setRawMode!(oldRaw ?? false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(buf);
      } else if (char === "\x7f" || char === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (char === "\x03") {
        process.stdout.write("\n");
        process.exit(0);
      } else {
        buf += char;
        process.stdout.write(c.dim + "*" + c.reset);
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function askChoice(
  rl: Interface,
  question: string,
  options: Array<{ key: string; label: string; description?: string }>,
  defaultKey?: string,
): Promise<string> {
  blank();
  print(`  ${c.yellow}?${c.reset} ${question}`);
  for (const opt of options) {
    const isDefault = opt.key === defaultKey;
    const marker = isDefault ? `${c.brightYellow}>${c.reset}` : " ";
    print(
      `  ${marker} ${c.bold}${c.cyan}${opt.key}${c.reset}${opt.description ? ` ${c.dim}— ${opt.description}${c.reset}` : ""} ${opt.label}`,
    );
  }
  const answer = await ask(rl, `Choice:`, defaultKey);
  const valid = options.find((o) => o.key === answer.toLowerCase());
  if (!valid) {
    print(theme.warn(`  Invalid choice. Using default: ${defaultKey}`));
    return defaultKey ?? options[0]!.key;
  }
  return valid.key;
}

async function askYesNo(rl: Interface, question: string, defaultVal = true): Promise<boolean> {
  const hint = defaultVal ? "Y/n" : "y/N";
  const answer = await ask(rl, `${question} ${c.dim}(${hint})${c.reset}`);
  if (!answer) return defaultVal;
  return answer.toLowerCase().startsWith("y");
}

// ── Steps ─────────────────────────────────────────────────

async function stepProvider(rl: Interface): Promise<Partial<SetupAnswers>> {
  print(theme.heading("  Step 1: AI Provider"));
  print(theme.dim("  Choose your primary AI provider for complex reasoning (Layer 3)."));

  const choice = await askChoice(
    rl,
    "Provider type:",
    [
      { key: "anthropic", label: "", description: "Anthropic API (Claude)" },
      { key: "openai", label: "", description: "OpenAI-compatible API" },
      { key: "ollama", label: "", description: "Ollama (local, no API key needed)" },
      { key: "skip", label: "", description: "Skip — configure later" },
    ],
    "anthropic",
  );

  if (choice === "skip") {
    return { providerType: "skip", apiKey: "", model: "" };
  }

  if (choice === "ollama") {
    const model = await ask(rl, "Ollama model name:", "gpt-oss:latest");
    const baseUrl = await ask(rl, "Ollama base URL:", "http://127.0.0.1:11434/v1");
    return {
      providerType: "ollama",
      apiKey: "ollama",
      model,
      baseUrl,
    };
  }

  const apiKey = await askSecret(rl, `${choice === "anthropic" ? "Anthropic" : "OpenAI"} API key:`);
  if (!apiKey) {
    print(theme.warn("  No API key provided. You can set it later in config."));
    return { providerType: choice as "anthropic" | "openai", apiKey: "", model: "" };
  }

  const defaultModel = choice === "anthropic" ? "claude-sonnet-4-6" : "gpt-4.1";
  const model = await ask(rl, "Model:", defaultModel);

  return { providerType: choice as "anthropic" | "openai", apiKey, model };
}

async function stepLocalModel(rl: Interface): Promise<{ localModel: boolean }> {
  blank();
  print(theme.heading("  Step 2: Local Model (Layer 2)"));
  print(theme.dim("  A local model handles disambiguation and simple reasoning"));
  print(theme.dim("  without using API tokens. Requires ~8GB RAM + Ollama."));
  blank();

  // Basic hardware detection
  const totalMemGB = Math.round(require("node:os").totalmem() / (1024 ** 3));
  if (totalMemGB < 8) {
    print(
      theme.warn(`  Detected ${totalMemGB}GB RAM — local model may be slow.`),
    );
    print(theme.dim("  Recommended: 8GB+ RAM for 7B parameter models."));
  } else {
    print(theme.dim(`  Detected ${totalMemGB}GB RAM — sufficient for local models.`));
  }

  const enabled = await askYesNo(rl, "Enable local model?", totalMemGB >= 8);
  return { localModel: enabled };
}

async function stepAuth(rl: Interface): Promise<Partial<SetupAnswers>> {
  blank();
  print(theme.heading("  Step 3: Authentication"));
  print(theme.dim("  How should the gateway authenticate incoming connections?"));

  const choice = await askChoice(
    rl,
    "Auth mode:",
    [
      { key: "token", label: "", description: "Token-based (recommended)" },
      { key: "password", label: "", description: "Password-based" },
      { key: "none", label: "", description: "No auth (local-only use)" },
    ],
    "token",
  );

  if (choice === "token") {
    const autoGen = await askYesNo(rl, "Auto-generate a secure token?", true);
    if (autoGen) {
      const token = `cm-${randomBytes(24).toString("base64url")}`;
      blank();
      print(`  ${theme.kv("Generated token", token)}`);
      print(theme.dim("  Save this — you'll need it to connect."));
      return { authMode: "token", authToken: token };
    }
    const token = await askSecret(rl, "Auth token (min 32 chars):");
    return { authMode: "token", authToken: token };
  }

  if (choice === "password") {
    const password = await askSecret(rl, "Password (min 12 chars):");
    return { authMode: "password", authPassword: password };
  }

  print(theme.warn("  No auth means anyone on localhost can connect."));
  return { authMode: "none" };
}

async function stepEmail(rl: Interface): Promise<Partial<SetupAnswers>> {
  blank();
  print(theme.heading("  Step 4: Email (optional)"));
  print(theme.dim("  CrabMeat's main way to work is email — send it a task and it"));
  print(theme.dim("  emails back the result. This connects a Gmail account."));

  const enable = await askYesNo(rl, "Set up email access now?", false);
  if (!enable) {
    print(theme.dim("  Skipped. Add connectors.emailImap to your config later."));
    return { emailEnabled: false };
  }

  blank();
  print(theme.dim("  Gmail needs an App Password (with 2-Step Verification on) —"));
  print(theme.dim("  not your normal password. Create one at:"));
  print(theme.accent("  https://myaccount.google.com/apppasswords"));
  blank();

  const user = await ask(rl, "Gmail address:");
  if (!looksLikeEmail(user)) {
    print(theme.warn("  Not a valid email address — skipping email setup."));
    return { emailEnabled: false };
  }

  const password = (await askSecret(rl, "App Password (16 characters):")).replace(
    /\s+/g,
    "",
  );
  if (password.length !== 16) {
    print(theme.warn("  App Passwords are 16 characters — skipping email setup."));
    return { emailEnabled: false };
  }

  // The sender allowlist doubles as the security boundary: mail from any
  // other address is dropped before it reaches the agent. Defaults to the
  // account itself — the common "email it from the same inbox" case.
  const fromRaw = await ask(rl, "Address you'll email it from:", user);
  const emailFrom = looksLikeEmail(fromRaw) ? fromRaw.trim() : user;

  return { emailEnabled: true, emailUser: user, emailPassword: password, emailFrom };
}

// ── Build config ──────────────────────────────────────────

function buildConfig(answers: SetupAnswers): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Provider
  if (answers.providerType !== "skip") {
    const provider: Record<string, unknown> = {
      id: answers.providerType === "ollama" ? "ollama-local" : answers.providerType,
      type: answers.providerType === "ollama" ? "openai" : answers.providerType,
      apiKey: answers.apiKey,
      model: answers.model,
    };
    if (answers.baseUrl) provider.baseUrl = answers.baseUrl;
    config.providers = [provider];

    if (answers.providerType === "ollama") {
      config.allowLocalProviders = true;
    }
  }

  // Auth
  const auth: Record<string, unknown> = { mode: answers.authMode };
  if (answers.authToken) auth.token = answers.authToken;
  if (answers.authPassword) auth.password = answers.authPassword;
  config.gateway = { auth };

  // Email connector. Credentials sit alongside the provider apiKey in
  // user-scope config — ~/.crabmeat/config.json never leaves the machine.
  // Only the fields without sane schema defaults are written; hosts,
  // ports, and poll interval fall through to the Gmail defaults.
  if (answers.emailEnabled && answers.emailUser && answers.emailPassword) {
    config.connectors = {
      emailImap: {
        user: answers.emailUser,
        password: answers.emailPassword,
        allowFromAddresses: [answers.emailFrom ?? answers.emailUser],
      },
    };
  }

  // Layer 2: local model disambiguation
  // When local model is enabled AND an Ollama provider was configured,
  // enable Layer 2 and point it at the Ollama provider.
  if (answers.localModel && answers.providerType === "ollama") {
    config.layer2 = {
      enabled: true,
      providerId: "ollama-local",
    };
  } else if (answers.localModel && answers.providerType !== "ollama") {
    // Local model enabled but primary provider isn't Ollama.
    // User may have a separate Ollama instance — note the preference
    // but leave Layer 2 disabled until they configure a local provider.
    config.layer2 = { enabled: false };
  } else {
    config.layer2 = { enabled: false };
  }

  return config;
}

// ── Main ──────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  print(BANNER);
  blank();
  print(
    box([
      theme.heading("  First-Run Setup  "),
      "",
      `  ${theme.dim("Configure CrabMeat for your environment.")}`,
      `  ${theme.dim("Settings are saved to ~/.crabmeat/config.json")}`,
      `  ${theme.dim("Re-run anytime with: crabmeat setup")}`,
    ]),
  );
  blank();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Check for existing config
    if (existsSync(USER_CONFIG_PATH)) {
      print(theme.warn(`  Existing config found at ${USER_CONFIG_PATH}`));
      const overwrite = await askYesNo(rl, "Overwrite existing config?", false);
      if (!overwrite) {
        print(theme.dim("  Setup cancelled. Existing config preserved."));
        rl.close();
        return;
      }
    }

    // Run steps
    const providerAnswers = await stepProvider(rl);
    const localModelAnswers = await stepLocalModel(rl);
    const authAnswers = await stepAuth(rl);
    const emailAnswers = await stepEmail(rl);

    const answers: SetupAnswers = {
      providerType: (providerAnswers.providerType as SetupAnswers["providerType"]) ?? "skip",
      apiKey: providerAnswers.apiKey ?? "",
      model: providerAnswers.model ?? "",
      baseUrl: providerAnswers.baseUrl,
      localModel: localModelAnswers.localModel,
      authMode: (authAnswers.authMode as SetupAnswers["authMode"]) ?? "token",
      authToken: authAnswers.authToken,
      authPassword: authAnswers.authPassword,
      emailEnabled: emailAnswers.emailEnabled ?? false,
      emailUser: emailAnswers.emailUser,
      emailPassword: emailAnswers.emailPassword,
      emailFrom: emailAnswers.emailFrom,
    };

    // Build and save
    blank();
    print(separator());
    blank();

    const spinner = createSpinner();
    spinner.start("Saving configuration...");

    const config = buildConfig(answers);

    // Merge with existing config if present, then atomically write.
    // writeJsonAtomicSync handles the parent-directory mkdir internally.
    let existingConfig: Record<string, unknown> = {};
    if (existsSync(USER_CONFIG_PATH)) {
      try {
        existingConfig = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8"));
      } catch {
        // Overwrite if corrupt
      }
    }

    const merged = { ...existingConfig, ...config };
    writeJsonAtomicSync(USER_CONFIG_PATH, merged);

    spinner.succeed(`Config saved to ${USER_CONFIG_PATH}`);
    blank();

    // Summary
    print(
      lightBox([
        theme.heading("  Setup Complete"),
        "",
        `  ${theme.kv("Provider", answers.providerType)}`,
        `  ${theme.kv("Model", answers.model || "none")}`,
        `  ${theme.kv("Local model", answers.localModel ? "enabled" : "disabled")}`,
        `  ${theme.kv("Auth", answers.authMode)}`,
        `  ${theme.kv("Email", answers.emailEnabled ? (answers.emailUser ?? "enabled") : "not configured")}`,
        `  ${theme.kv("Arbiter", "enabled (deterministic intent gate)")}`,
        `  ${theme.kv("Layer 2", answers.localModel && answers.providerType === "ollama" ? "enabled" : "disabled")}`,
        "",
        `  ${theme.dim("Next steps:")}`,
        `  ${theme.accent("  crabmeat run")}     ${theme.dim("Start the gateway")}`,
        `  ${theme.accent("  crabmeat chat")}    ${theme.dim("Interactive chat session")}`,
        `  ${theme.accent("  crabmeat setup")}   ${theme.dim("Re-run this wizard")}`,
      ], 55),
    );
    blank();
  } finally {
    rl.close();
  }
}
