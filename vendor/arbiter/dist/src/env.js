import { z } from "zod";
const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "production", "test"])
        .default("development"),
    LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("info"),
    ARBITER_STATE_DIR: z.string().optional(),
    ARBITER_SEARCH_ALLOWLIST: z.string().optional(),
});
let cached;
export function loadEnv() {
    if (cached)
        return cached;
    cached = envSchema.parse(process.env);
    return cached;
}
export function resetEnv() {
    cached = undefined;
}
export function isDev() {
    return loadEnv().NODE_ENV === "development";
}
export function isTest() {
    return loadEnv().NODE_ENV === "test";
}
//# sourceMappingURL=env.js.map