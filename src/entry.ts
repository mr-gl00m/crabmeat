#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createProgram } from "./cli/program.js";

// Load crabmeat/.env so $SECRET:NAME refs in crabmeat.json (which
// resolve through process.env) actually find their values. ENOENT is
// fine — production deployments set vars at the OS level instead.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  process.loadEnvFile(resolve(here, "../.env"));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const program = createProgram();
program.parseAsync(process.argv).catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
