import {
  readFile,
  writeFile,
  rename,
  mkdir,
  access,
  unlink,
  readdir,
  constants,
} from "node:fs/promises";
import {
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const absolute = resolve(filePath);
  const raw = await readFile(absolute, "utf-8");
  return JSON.parse(raw) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(resolve(filePath), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Atomically write a text blob to disk. Writes to a unique sibling tmp
// file and renames into place, so a crash mid-write leaves either the
// old file (if the rename never happened) or the new file (if it did)
// — never a half-written blob. The tmp suffix uses randomUUID rather
// than Date.now so concurrent writers to the same path can't collide
// on the tmp name.
//
// On any error after the tmp is created we unlink it best-effort; this
// covers rename failures (target locked on Windows, EACCES, etc.) so a
// thrown write doesn't also leak an orphan. A killed process can still
// leak — sweepAtomicTmpFiles handles that on next startup.
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const tmp = `${absolute}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, absolute);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// JSON wrapper over writeFileAtomic. Pretty-prints with 2-space indent.
export async function writeJsonAtomic<T>(
  filePath: string,
  data: T,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

// Sync variant for bootstrap paths (CLI setup before the event loop
// is running) that can't easily become async. Same atomicity guarantee
// and same orphan-cleanup behavior as the async variant.
export function writeJsonAtomicSync<T>(filePath: string, data: T): void {
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const tmp = `${absolute}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, absolute);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist yet */ }
    throw err;
  }
}

// Best-effort sweep of orphan atomic-write tempfiles in a single
// directory. Tempfiles take the form `<name>.tmp.<token>` and only
// exist between writeFile and rename — a successful write never leaves
// one behind. So on startup, any tempfile present is by definition
// stale (its writing process died) and safe to unlink.
//
// Non-recursive on purpose: callers own a single directory and know
// when no concurrent writes are in flight (typically at init time
// before any save() runs). Errors are swallowed individually so one
// stuck file doesn't block sweeping the rest.
export async function sweepAtomicTmpFiles(dir: string): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!basename(name).includes(".tmp.")) continue;
    try {
      await unlink(join(dir, name));
      removed++;
    } catch {
      // file may have vanished between readdir and unlink, or be locked
      // by an antivirus scan — either way, skip it
    }
  }
  return removed;
}
