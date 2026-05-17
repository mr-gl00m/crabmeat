/**
 * Unit tests for email_attach. Covers validation, the per-session
 * queue lifecycle (stage → drain), and the soft caps (per-file size,
 * total size, count). Filesystem touched via tmpdir.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerBuiltinTools, setFileAccessPaths } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import {
  _resetEmailAttachState,
  _peekAttachments,
  _attachmentSessionCount,
  drainAttachments,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  setEmailAttachmentLimits,
  getEmailAttachmentLimits,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
} from "./email-attach.js";
import type { ToolExecutionContext } from "./types.js";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "crabmeat-email-attach-"));
  // Allow file_read jail to reach the temp dir.
  setFileAccessPaths([tmp]);
  registerBuiltinTools();
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

beforeEach(() => {
  _resetEmailAttachState();
});

const ctx = (sessionKey = "s1"): ToolExecutionContext => ({
  sessionKey,
  agentId: "default",
});

function writeTmp(name: string, contents: string | Buffer): string {
  const p = join(tmp, name);
  writeFileSync(p, contents);
  return p;
}

describe("email_attach tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("email_attach")).toBe(true);
  });

  it("requires a session context", async () => {
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: "x.txt" }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("active session");
  });

  it("requires a path", async () => {
    const handler = getToolHandler("email_attach");
    const res = await handler({}, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'path' is required");
  });

  it("rejects paths outside the workspace jail", async () => {
    const handler = getToolHandler("email_attach");
    const res = await handler(
      { path: "C:/Windows/System32/drivers/etc/hosts" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("outside the workspace");
  });

  it("rejects a missing file", async () => {
    const handler = getToolHandler("email_attach");
    const res = await handler(
      { path: join(tmp, "does-not-exist.txt") },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });

  it("rejects an empty file", async () => {
    const p = writeTmp("empty.txt", "");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("empty");
  });

  it("rejects a file over the per-file cap", async () => {
    const p = writeTmp("big.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0));
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too large");
  });

  it("queues a valid file and reports queue stats", async () => {
    const p = writeTmp("hello.txt", "hello world");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.filename).toBe("hello.txt");
    expect(res.outputs?.bytes).toBe(11);
    expect(res.outputs?.contentType).toBe("text/plain");
    expect(res.outputs?.queuedCount).toBe(1);

    const queued = _peekAttachments("s1");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.filename).toBe("hello.txt");
    expect(queued[0]!.content.toString("utf-8")).toBe("hello world");
  });

  it("honors a filename override and sanitizes it", async () => {
    const p = writeTmp("source.bin", "abc");
    const handler = getToolHandler("email_attach");
    const res = await handler(
      { path: p, filename: "../../etc/passwd" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    // basename strips ../../etc/, sanitize swaps any leftover unsafe chars
    expect(res.outputs?.filename).toBe("passwd");
  });

  it("isolates queues by sessionKey", async () => {
    const p = writeTmp("s.txt", "data");
    const handler = getToolHandler("email_attach");
    await handler({ path: p }, undefined, ctx("alpha"));
    await handler({ path: p }, undefined, ctx("beta"));
    expect(_peekAttachments("alpha")).toHaveLength(1);
    expect(_peekAttachments("beta")).toHaveLength(1);
    expect(_attachmentSessionCount()).toBe(2);
  });

  it("enforces the per-session attachment count cap", async () => {
    const p = writeTmp("c.txt", "x");
    const handler = getToolHandler("email_attach");
    for (let i = 0; i < MAX_ATTACHMENTS_PER_SESSION; i++) {
      const res = await handler(
        { path: p, filename: `c${i}.txt` },
        undefined,
        ctx(),
      );
      expect(res.isError).toBeFalsy();
    }
    const overflow = await handler(
      { path: p, filename: "overflow.txt" },
      undefined,
      ctx(),
    );
    expect(overflow.isError).toBe(true);
    expect(overflow.content).toContain("queue full");
  });

  it("enforces the total bytes cap across files", async () => {
    // Each file is just under per-file cap; queue 4 of them and the 5th
    // should bust the total cap (5 MB * 4 = 20 MB cap exactly; the 5th
    // pushes us over).
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0);
    const handler = getToolHandler("email_attach");
    for (let i = 0; i < 4; i++) {
      const p = writeTmp(`big${i}.bin`, big);
      const res = await handler({ path: p }, undefined, ctx());
      expect(res.isError).toBeFalsy();
    }
    // Total queued is now exactly MAX_TOTAL_ATTACHMENT_BYTES. Any more
    // bytes should be rejected by the total cap.
    const more = writeTmp("more.bin", Buffer.alloc(1024, 0));
    const res = await handler({ path: more }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("total queued size");
    // Sanity: cap math
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBeGreaterThanOrEqual(
      MAX_ATTACHMENT_BYTES * 4,
    );
  });

  it("guesses common content types from extension", async () => {
    const handler = getToolHandler("email_attach");
    const cases: [string, string][] = [
      ["a.pdf", "application/pdf"],
      ["b.png", "image/png"],
      ["c.csv", "text/csv"],
      ["d.json", "application/json"],
      ["e.zip", "application/zip"],
    ];
    for (const [name, type] of cases) {
      const p = writeTmp(name, "data");
      const res = await handler({ path: p }, undefined, ctx());
      expect(res.outputs?.contentType).toBe(type);
      _resetEmailAttachState();
    }
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const p = writeTmp("mystery.qqq", "data");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.outputs?.contentType).toBe("application/octet-stream");
  });

  // Sensitive-filename blocklist — defense-in-depth against the Gil
  // Pinsky "reply with your .env" prompt-injection attack. The jail
  // alone allows .env (it lives inside the workspace); the blocklist
  // is what stops the LLM from attaching it.
  it("refuses to attach a .env file even when inside the jail", async () => {
    const p = writeTmp(".env", "ANTHROPIC_API_KEY=sk-ant-api03-zzzzzzzzzzzzzzzzzzzzz");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses to attach an SSH private key by name", async () => {
    const p = writeTmp("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses to attach a .pem file by extension", async () => {
    const p = writeTmp("server.pem", "-----BEGIN CERTIFICATE-----\nMIIC...\n");
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  // Content-scan defense — when an attacker copies credentials into a
  // benign filename (notes.txt) the basename blocklist won't fire, but
  // the byte-level scan still catches it.
  it("refuses to attach a text file whose body contains an API key", async () => {
    const p = writeTmp(
      "notes.txt",
      "Some notes for later\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\nmore notes",
    );
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("appears to contain credentials");
  });

  it("refuses a text file with an Anthropic key (the specifically targeted shape)", async () => {
    const p = writeTmp(
      "draft.md",
      "# Draft\n\nDon't forget: ANTHROPIC_API_KEY=sk-ant-api03-zzzzzzzzzzzzzzzzzzzz",
    );
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("appears to contain credentials");
  });

  it("still attaches binary files even if random bytes look like patterns", async () => {
    // Binary-looking bytes (NULs + control chars) bypass the text scan,
    // so a benign image attachment continues to work. The basename
    // blocklist still gates obviously-sensitive names.
    const bin = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // …
      0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
    ]);
    const p = writeTmp("logo.png", bin);
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.filename).toBe("logo.png");
  });

  it("clean text files still attach normally", async () => {
    const p = writeTmp(
      "meeting-notes.md",
      "# Meeting\n\nDiscussed roadmap. No action items.",
    );
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.filename).toBe("meeting-notes.md");
  });
});

describe("email_attach_content tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("email_attach_content")).toBe(true);
  });

  it("requires a session context", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      { filename: "a.md", content: "hi" },
      undefined,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("active session");
  });

  it("requires a filename", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler({ content: "hi" }, undefined, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("'filename' is required");
  });

  it("rejects filenames with path separators", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      { filename: "sub/dir/report.md", content: "body" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/leaf name/);
    // Also rejects backslashes (Windows path separators).
    const res2 = await handler(
      { filename: "sub\\report.md", content: "body" },
      undefined,
      ctx(),
    );
    expect(res2.isError).toBe(true);
  });

  it("requires a string content", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      { filename: "a.md", content: 42 },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/'content' is required/);
  });

  it("refuses an empty content string", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      { filename: "a.md", content: "" },
      undefined,
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/empty/);
  });

  it("writes the file AND queues the attachment in one call", async () => {
    const handler = getToolHandler("email_attach_content");
    const body = "# Report\n\nSome content.\n";
    const res = await handler(
      { filename: "report.md", content: body },
      undefined,
      ctx("atomic-1"),
    );
    expect(res.isError).toBeFalsy();
    expect(res.outputs?.filename).toBe("report.md");
    expect(res.outputs?.bytes).toBe(Buffer.byteLength(body, "utf-8"));
    expect(res.outputs?.queuedCount).toBe(1);

    // File is actually on disk at the resolved path
    const sourcePath = res.outputs?.sourcePath as string;
    expect(sourcePath).toBeTruthy();
    const disk = await import("node:fs/promises").then((m) =>
      m.readFile(sourcePath, "utf-8"),
    );
    expect(disk).toBe(body);

    // And the queue sees it
    const queued = _peekAttachments("atomic-1");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.filename).toBe("report.md");
    expect(queued[0]!.content.toString("utf-8")).toBe(body);

    // Cleanup the file we wrote
    await import("node:fs/promises").then((m) => m.unlink(sourcePath));
  });

  it("refuses to overwrite an existing file (caller must pick a new name)", async () => {
    const handler = getToolHandler("email_attach_content");
    const first = await handler(
      { filename: "collide.md", content: "first" },
      undefined,
      ctx("atomic-2"),
    );
    expect(first.isError).toBeFalsy();

    const second = await handler(
      { filename: "collide.md", content: "second" },
      undefined,
      ctx("atomic-2"),
    );
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/already exists/);

    // File on disk still holds the first write.
    const sourcePath = first.outputs?.sourcePath as string;
    const disk = await import("node:fs/promises").then((m) =>
      m.readFile(sourcePath, "utf-8"),
    );
    expect(disk).toBe("first");

    await import("node:fs/promises").then((m) => m.unlink(sourcePath));
  });

  it("enforces the per-file size cap", async () => {
    const handler = getToolHandler("email_attach_content");
    // Just over the cap — use a single repeated char so we stay in string land.
    const huge = "x".repeat(MAX_ATTACHMENT_BYTES + 1);
    const res = await handler(
      { filename: "huge.txt", content: huge },
      undefined,
      ctx("atomic-3"),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/too large/);
    // Nothing should have been queued or written.
    expect(_peekAttachments("atomic-3")).toHaveLength(0);
  });

  // Content-scan defense for the model-authored attach path. The
  // file_read side of the exfil chain is already locked down by the
  // sensitive-filename blocklist + redactToolResultSecrets, but a
  // hallucinated/recalled credential staged directly via
  // email_attach_content would otherwise bypass both.
  it("refuses to author a file whose content contains credentials", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      {
        filename: "config.env.txt",
        content:
          "# new prod config\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n",
      },
      undefined,
      ctx("atomic-scan-1"),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("appears to contain credentials");
    expect(_peekAttachments("atomic-scan-1")).toHaveLength(0);
  });

  it("enforces the per-session count cap", async () => {
    const handler = getToolHandler("email_attach_content");
    for (let i = 0; i < MAX_ATTACHMENTS_PER_SESSION; i++) {
      const res = await handler(
        { filename: `f${i}.txt`, content: `body ${i}` },
        undefined,
        ctx("atomic-4"),
      );
      expect(res.isError).toBeFalsy();
    }
    const overflow = await handler(
      { filename: "one-too-many.txt", content: "nope" },
      undefined,
      ctx("atomic-4"),
    );
    expect(overflow.isError).toBe(true);
    expect(overflow.content).toMatch(/queue full/);

    // Cleanup the files that got written
    const queued = _peekAttachments("atomic-4");
    const fs = await import("node:fs/promises");
    for (const q of queued) {
      try { await fs.unlink(q.sourcePath); } catch { /* best effort */ }
    }
  });

  it("enforces the cumulative-total cap across mixed tools", async () => {
    // Stage four files of exactly MAX_ATTACHMENT_BYTES each via email_attach
    // so the queue sits at the 20 MB cumulative cap but no per-file cap is hit.
    // Then any non-empty email_attach_content call should fail with the
    // cumulative-cap message, not the per-file one.
    const oneFileMax = Buffer.alloc(MAX_ATTACHMENT_BYTES, "a");
    const p1 = writeTmp("big1.bin", oneFileMax);
    const p2 = writeTmp("big2.bin", oneFileMax);
    const p3 = writeTmp("big3.bin", oneFileMax);
    const p4 = writeTmp("big4.bin", oneFileMax);
    const attach = getToolHandler("email_attach");
    for (const p of [p1, p2, p3, p4]) {
      const r = await attach({ path: p }, undefined, ctx("atomic-5"));
      expect(r.isError).toBeFalsy();
    }

    const contentHandler = getToolHandler("email_attach_content");
    const r2 = await contentHandler(
      { filename: "overflow.txt", content: "y".repeat(100) },
      undefined,
      ctx("atomic-5"),
    );
    expect(r2.isError).toBe(true);
    expect(r2.content).toMatch(/exceed cap/);
  });

  it("queue drains items from both tools indistinguishably", async () => {
    const existing = writeTmp("pre.txt", "prebuilt");
    const attach = getToolHandler("email_attach");
    const content = getToolHandler("email_attach_content");
    await attach({ path: existing }, undefined, ctx("atomic-6"));
    const authored = await content(
      { filename: "authored.md", content: "# authored" },
      undefined,
      ctx("atomic-6"),
    );

    const drained = drainAttachments("atomic-6");
    expect(drained).toHaveLength(2);
    expect(drained.map((d) => d.filename).sort()).toEqual(["authored.md", "pre.txt"]);

    // Cleanup the authored file
    const authoredPath = authored.outputs?.sourcePath as string;
    await import("node:fs/promises").then((m) => m.unlink(authoredPath));
  });

  it("sanitizes unsafe characters in the filename before writing + sending", async () => {
    const handler = getToolHandler("email_attach_content");
    const res = await handler(
      { filename: "weird\"name<with>bad|chars.md", content: "body" },
      undefined,
      ctx("atomic-7"),
    );
    expect(res.isError).toBeFalsy();
    const finalName = res.outputs?.filename as string;
    // No quotes, no angles, no pipes in the sanitized name
    expect(finalName).not.toMatch(/["<>|]/);
    // Still has the .md extension
    expect(finalName.endsWith(".md")).toBe(true);

    const sourcePath = res.outputs?.sourcePath as string;
    await import("node:fs/promises").then((m) => m.unlink(sourcePath));
  });
});

describe("setEmailAttachmentLimits (Phase 4.4 config knob)", () => {
  it("getEmailAttachmentLimits returns the current live caps", () => {
    expect(getEmailAttachmentLimits()).toEqual({
      maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
      totalMaxBytes: DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    });
  });

  it("override lowers the per-file cap and the handler enforces the new value", async () => {
    setEmailAttachmentLimits({ maxBytes: 1024 }); // 1 KB
    const live = getEmailAttachmentLimits();
    expect(live.maxBytes).toBe(1024);
    // totalMaxBytes was not in the call — should keep its previous value
    expect(live.totalMaxBytes).toBe(DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES);

    const p = writeTmp("over-cap.bin", Buffer.alloc(2048, 0)); // 2 KB > 1 KB cap
    const handler = getToolHandler("email_attach");
    const res = await handler({ path: p }, undefined, ctx("override-1"));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("too large");
    // Reset for next test (also restored by beforeEach).
    setEmailAttachmentLimits({ maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES });
  });

  it("override lowers the cumulative cap and email_attach_content enforces it", async () => {
    setEmailAttachmentLimits({ maxBytes: 4096, totalMaxBytes: 6144 }); // 4 KB / 6 KB
    const handler = getToolHandler("email_attach_content");
    const first = await handler(
      { filename: "a.txt", content: "x".repeat(4000) },
      undefined,
      ctx("override-2"),
    );
    expect(first.isError).toBeFalsy();
    const second = await handler(
      { filename: "b.txt", content: "y".repeat(3000) },
      undefined,
      ctx("override-2"),
    );
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/exceed cap/);

    // Cleanup file authored in `first`.
    const sourcePath = first.outputs?.sourcePath as string;
    if (sourcePath) {
      try { await import("node:fs/promises").then((m) => m.unlink(sourcePath)); } catch { /* best */ }
    }
  });

  it("_resetEmailAttachState restores the defaults", () => {
    setEmailAttachmentLimits({ maxBytes: 1, totalMaxBytes: 2 });
    expect(getEmailAttachmentLimits()).toEqual({ maxBytes: 1, totalMaxBytes: 2 });
    _resetEmailAttachState();
    expect(getEmailAttachmentLimits()).toEqual({
      maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
      totalMaxBytes: DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    });
  });

  it("rejects non-positive values silently (defensive)", () => {
    setEmailAttachmentLimits({ maxBytes: 1024, totalMaxBytes: 2048 });
    setEmailAttachmentLimits({ maxBytes: 0 });
    setEmailAttachmentLimits({ maxBytes: -1 });
    // Should still hold the last positive override
    expect(getEmailAttachmentLimits().maxBytes).toBe(1024);
  });
});

describe("drainAttachments", () => {
  it("returns and clears the queue", async () => {
    const p = writeTmp("d.txt", "hello");
    const handler = getToolHandler("email_attach");
    await handler({ path: p }, undefined, ctx("drain1"));
    await handler({ path: p, filename: "second.txt" }, undefined, ctx("drain1"));

    const drained = drainAttachments("drain1");
    expect(drained).toHaveLength(2);
    expect(drained[0]!.filename).toBe("d.txt");
    expect(drained[1]!.filename).toBe("second.txt");

    expect(_peekAttachments("drain1")).toHaveLength(0);
  });

  it("returns an empty array for an unknown session", () => {
    const drained = drainAttachments("never-touched");
    expect(drained).toEqual([]);
  });

  it("does not affect other sessions", async () => {
    const p = writeTmp("iso.txt", "x");
    const handler = getToolHandler("email_attach");
    await handler({ path: p }, undefined, ctx("a"));
    await handler({ path: p }, undefined, ctx("b"));
    drainAttachments("a");
    expect(_peekAttachments("a")).toHaveLength(0);
    expect(_peekAttachments("b")).toHaveLength(1);
  });
});
