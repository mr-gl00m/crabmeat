import { promises as fs, mkdirSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
// RT-2026-04-30-011 — unique tmp suffix per call so concurrent writers to the
// same target don't collide on `${path}.tmp`. PID for cross-process distinction
// plus a UUID for in-process distinction.
function tmpFor(absolute) {
    return `${absolute}.${process.pid}.${randomUUID()}.tmp`;
}
export async function readText(filePath) {
    return fs.readFile(resolve(filePath), "utf-8");
}
export async function readJsonFile(filePath) {
    const raw = await readText(filePath);
    return JSON.parse(raw);
}
export async function fileExists(filePath) {
    try {
        await fs.access(resolve(filePath));
        return true;
    }
    catch {
        return false;
    }
}
export async function atomicWriteText(filePath, content, opts = {}) {
    const absolute = resolve(filePath);
    await fs.mkdir(dirname(absolute), { recursive: true });
    const tmp = tmpFor(absolute);
    try {
        await fs.writeFile(tmp, content, opts.mode !== undefined
            ? { encoding: "utf-8", mode: opts.mode }
            : "utf-8");
        await fs.rename(tmp, absolute);
    }
    catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
    }
}
export async function atomicWriteJson(filePath, data, opts = {}) {
    await atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n", opts);
}
export function atomicWriteTextSync(filePath, content, opts = {}) {
    const absolute = resolve(filePath);
    mkdirSync(dirname(absolute), { recursive: true });
    const tmp = tmpFor(absolute);
    try {
        writeFileSync(tmp, content, opts.mode !== undefined
            ? { encoding: "utf-8", mode: opts.mode }
            : "utf-8");
        renameSync(tmp, absolute);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* tmp may not exist */
        }
        throw err;
    }
}
//# sourceMappingURL=atomic.js.map