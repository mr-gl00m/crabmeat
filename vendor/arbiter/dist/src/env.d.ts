import { z } from "zod";
declare const envSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<["development", "production", "test"]>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<["fatal", "error", "warn", "info", "debug", "trace"]>>;
    ARBITER_STATE_DIR: z.ZodOptional<z.ZodString>;
    ARBITER_SEARCH_ALLOWLIST: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    NODE_ENV: "development" | "production" | "test";
    LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    ARBITER_STATE_DIR?: string | undefined;
    ARBITER_SEARCH_ALLOWLIST?: string | undefined;
}, {
    NODE_ENV?: "development" | "production" | "test" | undefined;
    LOG_LEVEL?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | undefined;
    ARBITER_STATE_DIR?: string | undefined;
    ARBITER_SEARCH_ALLOWLIST?: string | undefined;
}>;
export type Env = z.infer<typeof envSchema>;
export declare function loadEnv(): Env;
export declare function resetEnv(): void;
export declare function isDev(): boolean;
export declare function isTest(): boolean;
export {};
//# sourceMappingURL=env.d.ts.map