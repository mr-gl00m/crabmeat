import { loadConfig } from "../config/loader.js";
import { createGateway } from "../gateway/server.js";
import { listOutboundConnectors } from "../connectors/outbound.js";
import { logger } from "../infra/logger.js";
import {
  bridgeDiagnosticsToPino,
  createMemorySampler,
  createOtelExporter,
  diagnostics,
  type MemorySampler,
  type OtelExporter,
} from "../infra/diagnostics/index.js";
import {
  theme,
  BANNER_COMPACT,
  separator,
  createSpinner,
  statusLine,
  print,
  blank,
} from "./ui.js";

export interface RunOptions {
  config?: string;
}

export async function runGateway(opts: RunOptions): Promise<void> {
  // ── Banner ──────────────────────────────────────────────
  blank();
  print(`  ${BANNER_COMPACT}  ${theme.dim("server")}`);
  blank();

  // ── Load config ─────────────────────────────────────────
  const spinner = createSpinner();
  spinner.start("Loading configuration...");

  let config;
  try {
    config = await loadConfig(opts.config);
    spinner.succeed("Configuration loaded");
  } catch (err) {
    spinner.fail(`Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // ── Config summary ──────────────────────────────────────
  const agent = config.agents[0];
  const provider = config.providers[0];

  print(separator());
  print(
    statusLine([
      { label: "agent", value: agent?.name ?? agent?.id ?? "default" },
      { label: "provider", value: provider ? `${provider.id} (${provider.model})` : "none" },
      { label: "arbiter", value: "enabled" },
    ]),
  );
  print(
    statusLine([
      { label: "auth", value: config.gateway.auth.mode },
      { label: "tools", value: `${config.tools.length + countBuiltins(config)}` },
      { label: "sessions", value: config.session.backend },
    ]),
  );
  print(separator());
  blank();

  // ── Start gateway ───────────────────────────────────────
  const gateway = createGateway(config);

  // ── Diagnostics bootstrap ───────────────────────────────
  // OTEL exporter returns null when no endpoint is configured; the bus
  // is unaffected and events still fan out to other subscribers (or
  // nothing). Memory sampler is always on — it's the leak canary.
  // Pino bridge is opt-in via CRABMEAT_DIAGNOSTICS_LOG=1 for dev.
  let otelExporter: OtelExporter | null = null;
  let memorySampler: MemorySampler | undefined;
  let diagnosticsPinoOff: (() => void) | undefined;
  try {
    if (process.env.CRABMEAT_DIAGNOSTICS_LOG === "1") {
      diagnosticsPinoOff = bridgeDiagnosticsToPino(diagnostics, logger);
    }
    otelExporter = await createOtelExporter(diagnostics, {
      serviceName: "crabmeat",
    });
    memorySampler = createMemorySampler();
    memorySampler.start();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Diagnostics bootstrap failed — continuing without observability",
    );
  }

  spinner.start("Starting gateway...");

  // Graceful shutdown
  const shutdown = (signal: string) => {
    blank();
    print(theme.warn(`  ${signal} received — shutting down...`));
    logger.info({ signal }, "Shutdown signal received");
    gateway.stop().then(
      async () => {
        memorySampler?.stop();
        diagnosticsPinoOff?.();
        if (otelExporter) {
          try {
            await otelExporter.shutdown();
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "OTEL exporter shutdown error",
            );
          }
        }
        print(theme.dim("  Gateway stopped. Goodbye."));
        process.exit(0);
      },
      (err) => {
        logger.error({ err }, "Error during shutdown");
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await gateway.start();
    spinner.succeed("Gateway ready");
    blank();

    const addr = `${config.gateway.tls ? "wss" : "ws"}://${config.gateway.host}:${config.gateway.port}`;
    print(theme.dim(`  Listening on ${addr}  (pid ${process.pid})`));

    // Surface the registered outbound connectors so the user has a
    // definitive signal at boot time about whether Discord (or any
    // other channel) is actually wired up. Without this, a missing
    // .crabmeat/local.json silently leaves message_send without
    // channels and the agent later claims "no connector configured".
    const connectorIds = listOutboundConnectors().map((c) => c.id).sort();
    if (connectorIds.length > 0) {
      print(theme.dim(`  Outbound connectors: [${connectorIds.join(", ")}]`));
    } else {
      print(
        theme.warn(
          "  Outbound connectors: [none] — message_send has no channels. " +
            "Add one to .crabmeat/local.json (see docs).",
        ),
      );
    }
    if (otelExporter) {
      print(theme.dim("  OTEL diagnostics: exporting to configured endpoint"));
    } else if (process.env.CRABMEAT_DIAGNOSTICS_LOG === "1") {
      print(theme.dim("  OTEL diagnostics: pino bridge only (set OTEL_EXPORTER_OTLP_ENDPOINT to export)"));
    }

    print(theme.dim("  Waiting for connections..."));
    blank();
  } catch (err) {
    spinner.fail(`Gateway failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/** Count built-in tools that would be registered at runtime. */
function countBuiltins(config: { agents: Array<{ tools: string[] }> }): number {
  const agent = config.agents[0];
  return agent?.tools.length ?? 0;
}
