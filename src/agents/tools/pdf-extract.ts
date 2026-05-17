/**
 * pdf_extract — extract and normalize text from PDF files.
 *
 * Ports the normalize_text pass from Cid's Python pdf_extractor:
 * NFKD unicode → whitespace collapse → hyphenated-line rejoin →
 * 3+ newlines → 2 → strip page-number-only lines →
 * remove duplicate header/footer lines (3+ occurrences, <120 chars).
 *
 * Uses pdfjs-dist (Mozilla's canonical JS PDF parser). First-party
 * handler; no external service.
 */

import { registerToolHandler } from "./handlers.js";
import { jailPathReal } from "./builtins.js";
import { formatErrorMessage } from "../../infra/errors.js";

const DEFAULT_MAX_PAGES = 2000;
const DEFAULT_MAX_CHARS = 1_000_000;
// Reject input files larger than this before pdfjs ever sees them.
// 50 MB covers any realistic local document while keeping a hostile or
// malformed PDF from exhausting daemon memory inside the readFile call.
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

type PdfResult = {
  content: string;
  isError?: boolean;
  outputs?: Record<string, unknown>;
};

/**
 * Faithful TS port of normalize_text(raw: str) from pdf_extractor.py.
 * Same passes, same order.
 */
export function normalizePdfText(raw: string): string {
  // NFKD: decompose compatibility chars (ligatures, fullwidth digits, etc.)
  let text = raw.normalize("NFKD");

  // Collapse whitespace runs (not including newline) to single space
  text = text.replace(/[^\S\n]+/g, " ");
  // Strip trailing spaces/tabs on lines
  text = text.replace(/[ \t]+\n/g, "\n");
  // Strip leading spaces/tabs on lines
  text = text.replace(/\n[ \t]+/g, "\n");
  // Rejoin hyphenated line-breaks ("word-\ncontinued" → "wordcontinued")
  text = text.replace(/(\w)-\s*\n\s*(\w)/g, "$1$2");
  // Collapse 3+ newlines to 2 (keep paragraph breaks, drop excess)
  text = text.replace(/\n{3,}/g, "\n\n");
  // Remove page-number-only lines (multiline mode)
  text = text.replace(/^\d+\s*$/gm, "");

  // Remove repeated header/footer lines:
  // any line that appears 3+ times, length < 120 chars, case-sensitive trimmed match.
  const lines = text.split("\n");
  const counts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  const repeated = new Set<string>();
  for (const [line, count] of counts) {
    if (count >= 3 && line.length < 120) {
      repeated.add(line);
    }
  }
  const filtered = lines.filter((line) => !repeated.has(line.trim()));
  text = filtered.join("\n");

  // Final collapse after header/footer removal
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function extractRaw(
  pdfPath: string,
  maxPages: number,
  maxBytes: number,
): Promise<{ text: string; pageCount: number; pagesRead: number }> {
  // Legacy build: no DOM, works in Node
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { readFile, stat } = await import("node:fs/promises");
  // stat before readFile so a 2 GB PDF cannot pull itself fully into memory
  // before any cap applies.
  const info = await stat(pdfPath);
  if (info.size > maxBytes) {
    throw new Error(
      `PDF too large: ${info.size} bytes exceeds cap of ${maxBytes} bytes.`,
    );
  }
  const data = new Uint8Array(await readFile(pdfPath));

  const loadingTask = pdfjs.getDocument({
    data,
    // Silence worker warnings in Node; extraction works without the worker
    // since pdfjs-dist falls back to running in the main thread.
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;

  const pageCount = pdf.numPages;
  const limit = Math.min(pageCount, maxPages);
  const parts: string[] = [];

  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // pdfjs text items have a `str` field with the string content.
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    parts.push(pageText);
    // Release page resources proactively — large PDFs otherwise bloat memory.
    page.cleanup();
  }

  await pdf.destroy();
  return {
    text: parts.join("\n"),
    pageCount,
    pagesRead: limit,
  };
}

async function handlePdfExtract(
  params: Record<string, unknown>,
): Promise<PdfResult> {
  const filePath = params.path as string;
  const normalize = params.normalize !== false; // default true
  const maxPages =
    typeof params.max_pages === "number" && params.max_pages > 0
      ? Math.floor(params.max_pages)
      : DEFAULT_MAX_PAGES;
  const maxChars =
    typeof params.max_chars === "number" && params.max_chars > 0
      ? Math.floor(params.max_chars)
      : DEFAULT_MAX_CHARS;
  const maxBytes =
    typeof params.max_bytes === "number" && params.max_bytes > 0
      ? Math.floor(params.max_bytes)
      : DEFAULT_MAX_BYTES;

  if (!filePath) {
    return { content: "The 'path' parameter is required.", isError: true };
  }

  const resolved = await jailPathReal(filePath);
  if (!resolved) {
    return {
      content: `Path blocked by workspace jail: '${filePath}'.`,
      isError: true,
    };
  }

  if (!/\.pdf$/i.test(resolved)) {
    return {
      content: `Not a PDF file: '${filePath}'. pdf_extract only handles .pdf.`,
      isError: true,
    };
  }

  try {
    const { text: raw, pageCount, pagesRead } = await extractRaw(resolved, maxPages, maxBytes);
    const processed = normalize ? normalizePdfText(raw) : raw;
    const truncated = processed.length > maxChars;
    const body = truncated ? processed.slice(0, maxChars) : processed;

    const pagesNote = pagesRead < pageCount
      ? ` (first ${pagesRead} of ${pageCount} pages)`
      : ` (${pageCount} pages)`;
    const truncNote = truncated ? ` [truncated to ${maxChars} chars]` : "";
    const head = `Extracted from ${filePath}${pagesNote}${truncNote}\n\n`;

    return {
      content: head + body,
      outputs: {
        path: resolved,
        text: body,
        page_count: pageCount,
        pages_read: pagesRead,
        char_count: body.length,
        normalized: normalize,
        truncated,
      },
    };
  } catch (err: unknown) {
    return {
      content: `PDF extraction error: ${formatErrorMessage(err)}`,
      isError: true,
    };
  }
}

export function registerPdfExtractTool(): void {
  registerToolHandler("pdf_extract", handlePdfExtract);
}
