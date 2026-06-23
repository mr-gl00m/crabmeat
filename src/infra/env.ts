import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  CRABMEAT_CONFIG: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = envSchema.parse(process.env);
  return cached;
}

export function isDev(): boolean {
  return loadEnv().NODE_ENV === "development";
}

export function isProd(): boolean {
  return loadEnv().NODE_ENV === "production";
}

export function isTest(): boolean {
  return loadEnv().NODE_ENV === "test";
}
