import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinTools, setFileAccessPaths } from "./builtins.js";
import { getToolHandler, hasToolHandler } from "./handlers.js";
import { normalizePdfText } from "./pdf-extract.js";

beforeAll(() => {
  registerBuiltinTools();
});

describe("normalizePdfText", () => {
  it("collapses whitespace runs to single space", () => {
    expect(normalizePdfText("hello    world")).toBe("hello world");
  });

  it("strips trailing spaces on lines", () => {
    expect(normalizePdfText("line one   \nline two")).toBe("line one\nline two");
  });

  it("strips leading spaces on lines", () => {
    expect(normalizePdfText("line one\n   line two")).toBe("line one\nline two");
  });

  it("rejoins hyphenated line-breaks", () => {
    expect(normalizePdfText("automat-\nically")).toBe("automatically");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(normalizePdfText("para one\n\n\n\npara two")).toBe("para one\n\npara two");
  });

  it("removes page-number-only lines", () => {
    const input = "text above\n42\nmore text";
    const out = normalizePdfText(input);
    expect(out).not.toContain("42");
    expect(out).toContain("text above");
    expect(out).toContain("more text");
  });

  it("removes lines that appear 3+ times (headers/footers)", () => {
    const header = "ACME Corp Confidential";
    const body = `${header}\npage one content\n${header}\npage two content\n${header}\npage three content`;
    const out = normalizePdfText(body);
    expect(out).not.toContain(header);
    expect(out).toContain("page one content");
    expect(out).toContain("page two content");
    expect(out).toContain("page three content");
  });

  it("preserves lines that appear fewer than 3 times", () => {
    const input = "Chapter 1\nsome text\nChapter 1\nmore text";
    const out = normalizePdfText(input);
    expect(out).toContain("Chapter 1");
  });

  it("preserves long repeated lines (≥120 chars)", () => {
    const longLine = "A".repeat(150);
    const input = `${longLine}\nbody\n${longLine}\nbody\n${longLine}`;
    const out = normalizePdfText(input);
    expect(out).toContain(longLine);
  });

  it("normalizes unicode ligatures via NFKD", () => {
    // U+FB01 LATIN SMALL LIGATURE FI decomposes to "fi"
    expect(normalizePdfText("efﬁcient")).toBe("efficient");
  });

  it("trims leading/trailing whitespace on output", () => {
    expect(normalizePdfText("\n\n  hello world  \n\n")).toBe("hello world");
  });
});

describe("pdf_extract tool", () => {
  it("is registered", () => {
    expect(hasToolHandler("pdf_extract")).toBe(true);
  });

  it("requires path parameter", async () => {
    const handler = getToolHandler("pdf_extract");
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("required");
  });

  it("rejects non-pdf paths", async () => {
    const handler = getToolHandler("pdf_extract");
    const res = await handler({ path: "README.md" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Not a PDF");
  });

  it("rejects jail-escaping paths", async () => {
    const handler = getToolHandler("pdf_extract");
    const res = await handler({ path: "../../../etc/passwd.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("jail");
  });

  it("surfaces extraction errors for missing files", async () => {
    const handler = getToolHandler("pdf_extract");
    const res = await handler({ path: "nonexistent-file-zzz.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("extraction error");
  });

  describe("input byte cap (RT-2026-05-01-005)", () => {
    let tmpDir: string;
    let pdfPath: string;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "crabmeat-pdf-cap-"));
      setFileAccessPaths([tmpDir]);
      pdfPath = join(tmpDir, "oversized.pdf");
      // 64 KB of bytes — well over the 1 KB cap below, well under any
      // realistic real-PDF size, so the cap fires before pdfjs ever runs.
      await writeFile(pdfPath, Buffer.alloc(64 * 1024, 0x41));
    });

    afterAll(async () => {
      setFileAccessPaths([]);
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("rejects files larger than max_bytes before pdfjs parses them", async () => {
      const handler = getToolHandler("pdf_extract");
      const res = await handler({ path: pdfPath, max_bytes: 1024 });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("PDF too large");
      expect(res.content).toContain("1024");
    });
  });
});
