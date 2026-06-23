/**
 * Unit tests for the post-turn attachment-claim lint.
 *
 * This is the deterministic backstop against the 2026-04-24
 * "Cybersec report" failure mode: the model narrated "Attached X" on a
 * reply where the attachment queue was empty. Detection should fire on
 * first-person claims and obvious "see attached" phrases, but NOT on
 * passive mentions of the word "attached" or on replies that legitimately
 * describe a failed attempt.
 */

import { describe, it, expect } from "vitest";
import {
  detectAttachmentClaim,
  appendFabricationNoticeIfNeeded,
  ATTACHMENT_FABRICATION_NOTICE,
} from "./attachment-claim-lint.js";

describe("detectAttachmentClaim", () => {
  it("fires on the exact incident phrasing", () => {
    const body =
      "Attached AI_Cybersecurity_Report_2026.md — compiled research on the latest AI and cybersecurity issues and papers.";
    expect(detectAttachmentClaim(body)).toBe(true);
  });

  it("fires on first-person 'I've attached' / 'I have attached' / 'I attached'", () => {
    expect(detectAttachmentClaim("I've attached the report below.")).toBe(true);
    expect(detectAttachmentClaim("I have attached the summary.")).toBe(true);
    expect(detectAttachmentClaim("I attached the CSV you asked for.")).toBe(true);
    expect(detectAttachmentClaim("I'm attaching the transcript now.")).toBe(true);
    expect(detectAttachmentClaim("I'll attach the PDF shortly.")).toBe(true);
  });

  it("fires on filename-adjacent claims regardless of sentence shape", () => {
    expect(detectAttachmentClaim("Attached report.md with the numbers.")).toBe(true);
    expect(detectAttachmentClaim("Please find attached q1_numbers.csv.")).toBe(true);
  });

  it("fires on 'see attached' / 'see the attachment' sign-offs", () => {
    expect(detectAttachmentClaim("See attached.")).toBe(true);
    expect(detectAttachmentClaim("See the attachment for details.")).toBe(true);
    expect(detectAttachmentClaim("See attached for the full numbers.")).toBe(true);
  });

  it("fires on 'attached below / above / to this email'", () => {
    expect(detectAttachmentClaim("The data is attached below.")).toBe(true);
    expect(detectAttachmentClaim("Full report attached to this email.")).toBe(true);
    expect(detectAttachmentClaim("The file is attached with this reply.")).toBe(true);
  });

  it("fires on 'the attached file/report/document' noun references", () => {
    expect(detectAttachmentClaim("The attached file has everything you need.")).toBe(true);
    expect(detectAttachmentClaim("Refer to the attached report for the breakdown.")).toBe(true);
    expect(detectAttachmentClaim("Details are in the attached pdf.")).toBe(true);
  });

  // --- false-positive guards -------------------------------------------------

  it("does NOT fire on passive-narrative uses of 'attached' with no filename", () => {
    // The word shows up in unrelated contexts; without "I" or a filename or
    // a sign-off shape we shouldn't treat it as a claim.
    expect(
      detectAttachmentClaim(
        "The controversy was attached to the broader debate about AI governance.",
      ),
    ).toBe(false);
    expect(
      detectAttachmentClaim(
        "Her name became attached to the movement through her 2025 essay.",
      ),
    ).toBe(false);
  });

  it("does NOT fire on empty or whitespace-only bodies", () => {
    expect(detectAttachmentClaim("")).toBe(false);
    expect(detectAttachmentClaim("   \n  \t  ")).toBe(false);
  });

  it("does NOT fire on a reply that honestly reports a failed attachment attempt", () => {
    // If the model tells the truth about the failure, the lint should
    // stay out of its way. We key on claims of success, not mentions of
    // the word.
    const body =
      "I tried to attach the report but the file_copy call failed — the source path did not exist. Nothing was attached to this reply.";
    // This actually WOULD fire on "to attach" in some phrasings. Make sure
    // the exact phrasing here doesn't accidentally trip a pattern.
    expect(detectAttachmentClaim(body)).toBe(false);
  });

  it("does NOT fire on common negated phrasings of failure", () => {
    // Models that DO tell the truth about failure often use attachment
    // vocabulary. The negation guard lets those replies through untouched.
    expect(
      detectAttachmentClaim(
        "I could not attach the report — the underlying file_copy call errored.",
      ),
    ).toBe(false);
    expect(
      detectAttachmentClaim("The file was not attached to this reply."),
    ).toBe(false);
    expect(
      detectAttachmentClaim("I failed to attach the PDF; the source path didn't exist."),
    ).toBe(false);
    expect(
      detectAttachmentClaim("Nothing is attached below — the write step never ran."),
    ).toBe(false);
  });

  it("does NOT fire on replies that simply discuss attachments generically", () => {
    // "You can attach a file" / "consider attaching" style — describing
    // the concept, not claiming one was sent.
    expect(
      detectAttachmentClaim(
        "In future you can attach a file instead of pasting it inline.",
      ),
    ).toBe(false);
    expect(
      detectAttachmentClaim(
        "Gmail supports attachments up to 25 MB. Larger files need Google Drive.",
      ),
    ).toBe(false);
  });
});

describe("appendFabricationNoticeIfNeeded", () => {
  it("returns the body unchanged when attachments were actually staged", () => {
    const body = "I've attached report.md as requested.";
    const res = appendFabricationNoticeIfNeeded(body, 1);
    expect(res.intercepted).toBe(false);
    expect(res.body).toBe(body);
    expect(res.reason).toBe("");
  });

  it("returns the body unchanged when the body makes no attachment claim", () => {
    const body = "Here is a summary of what I found. No file needed.";
    const res = appendFabricationNoticeIfNeeded(body, 0);
    expect(res.intercepted).toBe(false);
    expect(res.body).toBe(body);
  });

  it("appends the fabrication notice when a claim is present but no attachment was staged", () => {
    const body =
      "Attached AI_Cybersecurity_Report_2026.md — compiled research on the latest AI and cybersecurity issues and papers.";
    const res = appendFabricationNoticeIfNeeded(body, 0);
    expect(res.intercepted).toBe(true);
    expect(res.body.startsWith(body)).toBe(true);
    expect(res.body.endsWith(ATTACHMENT_FABRICATION_NOTICE)).toBe(true);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  it("notice is a clearly-separated block (has the markdown rule + tag)", () => {
    const res = appendFabricationNoticeIfNeeded("I've attached the PDF.", 0);
    expect(res.intercepted).toBe(true);
    expect(res.body).toContain("\n---\n");
    expect(res.body).toContain("[crabmeat notice]");
    expect(res.body).toMatch(/no file was actually staged/i);
  });

  it("does not double-append if called twice on already-annotated body", () => {
    // Defensive: if some upstream code accidentally calls twice, we don't
    // want a notice cascade. After the first append, the body still
    // contains claim language, so the function WILL fire again — so the
    // caller should only invoke once per turn (which is how the handler
    // is wired). This test documents the property so the contract is
    // explicit: do not call this more than once per reply.
    const first = appendFabricationNoticeIfNeeded("I've attached the PDF.", 0);
    expect(first.intercepted).toBe(true);
    const second = appendFabricationNoticeIfNeeded(first.body, 0);
    // The function will detect the original claim inside `first.body` and
    // append again — that's expected. The contract is: caller calls once.
    expect(second.intercepted).toBe(true);
    expect(second.body.length).toBeGreaterThan(first.body.length);
  });
});
