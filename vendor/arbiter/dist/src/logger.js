import pino from "pino";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv, isTest } from "./env.js";
function stateDir() {
    return loadEnv().ARBITER_STATE_DIR ?? join(homedir(), ".arbiter");
}
function logDir() {
    return join(stateDir(), "logs");
}
function createLogger() {
    const env = loadEnv();
    if (isTest()) {
        return pino({ name: "arbiter", level: "silent" });
    }
    if (env.NODE_ENV === "development") {
        return pino({
            name: "arbiter",
            level: env.LOG_LEVEL,
            transport: {
                target: "pino/file",
                options: { destination: 1 },
            },
        });
    }
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    return pino({
        name: "arbiter",
        level: env.LOG_LEVEL,
        transport: {
            target: "pino/file",
            options: { destination: join(dir, "arbiter.log"), mkdir: true },
        },
    });
}
export const logger = createLogger();
//# sourceMappingURL=logger.js.map