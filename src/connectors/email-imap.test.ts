/**
 * Unit tests for the pure helpers in email-imap.ts. End-to-end IMAP/SMTP
 * tests would need a live mailbox to be useful and are deferred — these
 * cover the parsing + sanitization layer, which is where logic bugs hide.
 */

import { describe, it, expect } from "vitest";
import nodemailer from "nodemailer";
import { createEmailImapConnector, _internal, parseAuthenticationResults } from "./email-imap.js";
import { getOutboundConnector, _resetOutboundRegistry } from "./outbound.js";
import { emailImapConnectorConfigSchema } from "../config/schema.js";

const {
  extractAddress,
  extractAllAddresses,
  stripQuotedReply,
  buildThreadHeaders,
  classifyInbound,
  bodyLooksForwarded,
  buildInboundContext,
  computeThreadRoot,
  selectInboundBody,
  hasReplyPrefix,
  stripReplyOrForwardPrefix,
  buildReplySubject,
} = _internal;

describe("extractAddress", () => {
  it("returns lowercased trimmed string", () => {
    expect(extractAddress("  Foo@Example.COM  ")).toBe("foo@example.com");
  });

  it("pulls .address from an object", () => {
    expect(extractAddress({ address: "A@B.COM", name: "A" })).toBe("a@b.com");
  });

  it("walks a value array", () => {
    expect(
      extractAddress({
        value: [{ address: "Hi@Example.com", name: "Hi" }],
      }),
    ).toBe("hi@example.com");
  });

  it("walks a top-level array", () => {
    expect(
      extractAddress([
        { address: "first@x.com" },
        { address: "second@x.com" },
      ]),
    ).toBe("first@x.com");
  });

  it("returns undefined for nullish or unrecognized shapes", () => {
    expect(extractAddress(null)).toBeUndefined();
    expect(extractAddress(undefined)).toBeUndefined();
    expect(extractAddress(42)).toBeUndefined();
    expect(extractAddress({ foo: "bar" })).toBeUndefined();
  });
});

describe("extractAllAddresses", () => {
  it("returns an empty array for nullish input", () => {
    expect(extractAllAddresses(null)).toEqual([]);
    expect(extractAllAddresses(undefined)).toEqual([]);
  });

  it("pulls every address from a top-level array of objects", () => {
    expect(
      extractAllAddresses([
        { address: "First@X.com", name: "First" },
        { address: "second@x.com", name: "Second" },
        { address: "THIRD@x.com", name: "Third" },
      ]),
    ).toEqual(["first@x.com", "second@x.com", "third@x.com"]);
  });

  it("walks a mailparser-style {value: [...]} wrapper", () => {
    expect(
      extractAllAddresses({
        value: [{ address: "a@x.com" }, { address: "b@x.com" }],
        text: "a@x.com, b@x.com",
      }),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("dedupes case-insensitively, preserving first-seen order", () => {
    expect(
      extractAllAddresses([
        { address: "Dup@x.com" },
        { address: "other@x.com" },
        { address: "DUP@x.com" },
        { address: "dup@X.COM" },
      ]),
    ).toEqual(["dup@x.com", "other@x.com"]);
  });

  it("skips empty/unparseable entries instead of throwing", () => {
    expect(
      extractAllAddresses([
        { address: "ok@x.com" },
        { name: "no-address-field" },
        "",
        "  ",
        { address: "also@x.com" },
      ]),
    ).toEqual(["ok@x.com", "also@x.com"]);
  });
});

describe("stripQuotedReply", () => {
  it("returns body unchanged when there is no quote block", () => {
    expect(stripQuotedReply("hello there")).toBe("hello there");
  });

  it("cuts at 'On <date> X wrote:' marker", () => {
    const body = [
      "Here is my reply.",
      "",
      "On Mon, Apr 13 2026, Crabmeat <bot@example.com> wrote:",
      "> previous",
      "> message",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Here is my reply.");
  });

  it("cuts at -- Original Message -- marker", () => {
    const body = [
      "Reply text.",
      "-----Original Message-----",
      "From: someone",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Reply text.");
  });

  it("drops trailing > quote lines even without a header", () => {
    const body = ["Real content", "> quoted", "> more quoted"].join("\n");
    expect(stripQuotedReply(body)).toBe("Real content");
  });

  it("preserves > characters that are not at line start", () => {
    expect(stripQuotedReply("a > b")).toBe("a > b");
  });

  it("cuts at a Gmail-mobile wrapped 'On <date>...wrote:' across 2 lines", () => {
    const body = [
      "Here is my reply.",
      "",
      "On Mon, Apr 14, 2026 at 3:45 PM",
      "Crabmeat <bot@example.com> wrote:",
      "> previous",
      "> message",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Here is my reply.");
  });

  it("cuts at a Gmail-mobile wrapped attribution across 3 lines", () => {
    const body = [
      "Reply content.",
      "",
      "On Mon, Apr 14, 2026 at",
      "3:45 PM, Crabmeat",
      "<bot@example.com> wrote:",
      "> older",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Reply content.");
  });

  it("cuts at an Outlook-style 3-line header block", () => {
    const body = [
      "Thanks, that works for me.",
      "",
      "From: Someone <someone@example.com>",
      "Sent: Monday, April 14, 2026 3:45 PM",
      "To: Me <me@example.com>",
      "Subject: Re: the thing",
      "",
      "Earlier content we don't want.",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Thanks, that works for me.");
  });

  it("cuts at 'Begin forwarded message:' (Apple Mail)", () => {
    const body = [
      "FYI — see below.",
      "",
      "Begin forwarded message:",
      "",
      "From: Source",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("FYI — see below.");
  });

  it("cuts at a long underscore horizontal rule separator", () => {
    const body = [
      "Quick ack.",
      "",
      "________________________________",
      "From: X",
      "Sent: Yesterday",
      "To: Y",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe("Quick ack.");
  });

  it("does NOT false-positive on a single stray 'From:' line in user text", () => {
    // Only ONE header-looking line — shouldn't cut.
    const body = "From: my perspective this is the best approach.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does NOT false-positive on a short underscore markdown rule", () => {
    // Only 4 underscores — too short to be a real separator.
    const body = "Section A\n\n____\n\nSection B";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does NOT false-positive on 'On ' sentences that aren't attributions", () => {
    // Line starts with "On " but no "wrote:" anywhere nearby.
    const body = [
      "On the topic of pricing, I think we should hold at $49.",
      "",
      "Let me know what you think.",
    ].join("\n");
    expect(stripQuotedReply(body)).toBe(body);
  });
});

describe("buildThreadHeaders", () => {
  it("returns undefined when the inbound has no Message-ID", () => {
    expect(buildThreadHeaders(undefined, undefined)).toBeUndefined();
    expect(buildThreadHeaders(undefined, "<a@x>")).toBeUndefined();
  });

  it("emits a single-element References when the inbound has no References", () => {
    const out = buildThreadHeaders("<m1@x>", undefined);
    expect(out).toEqual({ inReplyTo: "<m1@x>", references: ["<m1@x>"] });
  });

  it("appends the inbound Message-ID to an existing References array", () => {
    // Thread of three: M1 → reply1 → reply2. Inbound is reply2.
    const out = buildThreadHeaders("<reply2@x>", ["<m1@x>", "<reply1@x>"]);
    expect(out).toEqual({
      inReplyTo: "<reply2@x>",
      references: ["<m1@x>", "<reply1@x>", "<reply2@x>"],
    });
  });

  it("parses a space-separated References STRING into an array", () => {
    // mailparser sometimes returns the raw wire format as a string.
    const out = buildThreadHeaders("<reply2@x>", "<m1@x> <reply1@x>");
    expect(out).toEqual({
      inReplyTo: "<reply2@x>",
      references: ["<m1@x>", "<reply1@x>", "<reply2@x>"],
    });
  });

  it("handles References strings with extra whitespace and newlines", () => {
    // Real-world headers can include CRLF folding inside header values.
    const out = buildThreadHeaders("<r3@x>", "  <m1@x>\n  <r1@x>\t<r2@x>  ");
    expect(out?.references).toEqual(["<m1@x>", "<r1@x>", "<r2@x>", "<r3@x>"]);
  });

  it("does NOT duplicate the inbound Message-ID if it already appears in References", () => {
    // Some buggy MUAs put their own Message-ID into their own References.
    const out = buildThreadHeaders("<m1@x>", ["<m0@x>", "<m1@x>"]);
    expect(out?.references).toEqual(["<m0@x>", "<m1@x>"]);
  });

  it("filters out non-string and empty entries from a References array", () => {
    const out = buildThreadHeaders(
      "<m2@x>",
      // mailparser is loose-typed — defend against junk entries
      ["<m1@x>", "", null as unknown as string, undefined as unknown as string],
    );
    expect(out?.references).toEqual(["<m1@x>", "<m2@x>"]);
  });

  it("yields a long, ordered chain across many hops (smoke test)", () => {
    const chain = ["<m1@x>", "<m2@x>", "<m3@x>", "<m4@x>", "<m5@x>"];
    const out = buildThreadHeaders("<m6@x>", chain);
    expect(out?.references).toEqual([
      "<m1@x>",
      "<m2@x>",
      "<m3@x>",
      "<m4@x>",
      "<m5@x>",
      "<m6@x>",
    ]);
    expect(out?.inReplyTo).toBe("<m6@x>");
  });
});

describe("classifyInbound", () => {
  it("flags Fwd: / FW: / Fw: prefixes as forwards", () => {
    expect(classifyInbound({ subject: "Fwd: quarterly report", ccCount: 0 }).isForward).toBe(
      true,
    );
    expect(classifyInbound({ subject: "FW: quarterly report", ccCount: 0 }).isForward).toBe(
      true,
    );
    expect(classifyInbound({ subject: "Fw: quarterly report", ccCount: 0 }).isForward).toBe(
      true,
    );
    expect(classifyInbound({ subject: "  fwd:  something  ", ccCount: 0 }).isForward).toBe(
      true,
    );
  });

  it("does NOT flag plain subjects or Re: as forwards", () => {
    expect(classifyInbound({ subject: "Re: quarterly report", ccCount: 0 }).isForward).toBe(
      false,
    );
    expect(classifyInbound({ subject: "quarterly report", ccCount: 0 }).isForward).toBe(
      false,
    );
    // "forward" as a word in the subject is NOT the Fwd: prefix — don't
    // false-positive on natural language.
    expect(
      classifyInbound({ subject: "please forward this later", ccCount: 0 }).isForward,
    ).toBe(false);
  });

  it("sets isMultiParty based on ccCount", () => {
    expect(classifyInbound({ subject: "hi", ccCount: 0 }).isMultiParty).toBe(false);
    expect(classifyInbound({ subject: "hi", ccCount: 1 }).isMultiParty).toBe(true);
    expect(classifyInbound({ subject: "hi", ccCount: 5 }).isMultiParty).toBe(true);
  });

  it("reports recipientCount as ccCount + 1 (the sender)", () => {
    expect(classifyInbound({ subject: "hi", ccCount: 0 }).recipientCount).toBe(1);
    expect(classifyInbound({ subject: "hi", ccCount: 3 }).recipientCount).toBe(4);
  });

  it("flags body forward markers as forwards even when subject lacks Fwd: prefix", () => {
    // Regression guard for the open Phase 4 bug
    // (project_phase4_test_findings.md): user forwards an email and edits
    // the Fwd: prefix out of the subject. Without body-marker detection,
    // selectInboundBody runs stripQuotedReply, which cuts at the
    // "Begin forwarded message:" marker and the agent receives no
    // content to summarize.
    const appleMail = classifyInbound({
      subject: "fyi check this out",
      ccCount: 0,
      rawBody:
        "Thought you'd want to see this.\n\nBegin forwarded message:\n\nFrom: Sender\nSubject: Q3 numbers\n\nThe original content lives down here.",
    });
    expect(appleMail.isForward).toBe(true);

    const gmail = classifyInbound({
      subject: "look at this",
      ccCount: 0,
      rawBody:
        "Heads up.\n\n---------- Forwarded message ----------\nFrom: Sender\nSubject: Q3 numbers\n\nForwarded content.",
    });
    expect(gmail.isForward).toBe(true);
  });

  it("does NOT flag a plain reply with quoted history as a forward", () => {
    // The "On <date>, X wrote:" style is a reply marker, not a forward.
    // It must NOT trip body-marker forward detection — that would
    // disable stripQuotedReply on every reply with quote history.
    const reply = classifyInbound({
      subject: "Re: scheduling",
      ccCount: 0,
      rawBody:
        "Yes, that works.\n\nOn Mon, Apr 14, 2026, X wrote:\n> let's meet tuesday",
    });
    expect(reply.isForward).toBe(false);
  });

  it("subject-only path still works when rawBody is omitted", () => {
    // Backwards compatibility — older tests and any callers that don't
    // care about body markers can omit rawBody and get subject-prefix
    // behavior unchanged.
    expect(classifyInbound({ subject: "Fwd: hi", ccCount: 0 }).isForward).toBe(true);
    expect(classifyInbound({ subject: "Re: hi", ccCount: 0 }).isForward).toBe(false);
  });
});

describe("hasReplyPrefix / stripReplyOrForwardPrefix / buildReplySubject", () => {
  it("recognizes English Re: as a reply prefix", () => {
    expect(hasReplyPrefix("Re: foo")).toBe(true);
    expect(hasReplyPrefix("RE: foo")).toBe(true);
    expect(hasReplyPrefix("re:foo")).toBe(true);
  });

  it("recognizes German AW: / Antw: as reply prefixes", () => {
    expect(hasReplyPrefix("AW: foo")).toBe(true);
    expect(hasReplyPrefix("Antw: foo")).toBe(true);
  });

  it("recognizes Scandinavian SV: and Finnish VS: as reply prefixes", () => {
    expect(hasReplyPrefix("SV: foo")).toBe(true);
    expect(hasReplyPrefix("VS: foo")).toBe(true);
  });

  it("recognizes Polish/Czech Odp: and Russian Ответ: as reply prefixes", () => {
    expect(hasReplyPrefix("Odp: foo")).toBe(true);
    expect(hasReplyPrefix("Ответ: foo")).toBe(true);
    expect(hasReplyPrefix("ОТВЕТ: foo")).toBe(true);
  });

  it("does NOT treat Fwd: / FW: as reply prefixes", () => {
    expect(hasReplyPrefix("Fwd: foo")).toBe(false);
    expect(hasReplyPrefix("FW: foo")).toBe(false);
  });

  it("does NOT false-match natural-language uses", () => {
    expect(hasReplyPrefix("ready: foo")).toBe(false);
    expect(hasReplyPrefix("review: bar")).toBe(false);
    expect(hasReplyPrefix("answer this")).toBe(false);
  });

  it("strips reply or forward prefix and trims the remainder", () => {
    expect(stripReplyOrForwardPrefix("Re: hi")).toBe("hi");
    expect(stripReplyOrForwardPrefix("AW: quarterly report")).toBe("quarterly report");
    expect(stripReplyOrForwardPrefix("Fwd: thread root")).toBe("thread root");
    expect(stripReplyOrForwardPrefix("  fw:  spaces  ")).toBe("spaces");
    expect(stripReplyOrForwardPrefix("untagged subject")).toBe("untagged subject");
  });

  it("normalizes localized reply prefixes to Re: in the outbound subject", () => {
    expect(buildReplySubject("AW: quarterly")).toBe("Re: quarterly");
    expect(buildReplySubject("Antw: scheduling")).toBe("Re: scheduling");
    expect(buildReplySubject("SV: lunch?")).toBe("Re: lunch?");
    expect(buildReplySubject("Ответ: вопрос")).toBe("Re: вопрос");
  });

  it("does not double-prepend Re: when subject already has it", () => {
    expect(buildReplySubject("Re: foo")).toBe("Re: foo");
    expect(buildReplySubject("RE: bar")).toBe("Re: bar");
  });

  it("preserves Fwd: prefix on a reply (so reply-to-forward stays Re: Fwd:)", () => {
    // "Re: Fwd: foo" is the conventional shape — replying to a forwarded
    // thread carries the forward provenance. We don't strip it.
    expect(buildReplySubject("Fwd: quarterly numbers")).toBe(
      "Re: Fwd: quarterly numbers",
    );
  });

  it("falls back to '(no subject)' on empty / prefix-only input", () => {
    expect(buildReplySubject("")).toBe("Re: (no subject)");
    expect(buildReplySubject("Re:")).toBe("Re: (no subject)");
    expect(buildReplySubject("AW: ")).toBe("Re: (no subject)");
  });
});

describe("bodyLooksForwarded", () => {
  it("matches Apple Mail 'Begin forwarded message:'", () => {
    expect(
      bodyLooksForwarded("note from me\n\nBegin forwarded message:\n\nFrom: x"),
    ).toBe(true);
  });

  it("matches Gmail/Outlook '----- Forwarded message -----' with varying dashes", () => {
    expect(
      bodyLooksForwarded("---------- Forwarded message ----------\nFrom: x"),
    ).toBe(true);
    expect(
      bodyLooksForwarded("--- Forwarded Message ---\nFrom: x"),
    ).toBe(true);
  });

  it("does not match plain reply quoted history", () => {
    expect(
      bodyLooksForwarded("Yes\n\nOn Mon, X wrote:\n> earlier text"),
    ).toBe(false);
  });

  it("does not match Outlook '----- Original Message -----' (ambiguous — used for replies too)", () => {
    expect(
      bodyLooksForwarded("Reply text.\n\n-----Original Message-----\nFrom: x"),
    ).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(bodyLooksForwarded("")).toBe(false);
  });
});

describe("buildInboundContext", () => {
  it("returns undefined for a plain 1:1 non-forward", () => {
    const ctx = buildInboundContext({
      isForward: false,
      isMultiParty: false,
      recipientCount: 1,
    });
    expect(ctx).toBeUndefined();
  });

  it("produces a forward note for forwarded messages", () => {
    const ctx = buildInboundContext({
      isForward: true,
      isMultiParty: false,
      recipientCount: 1,
    });
    expect(ctx).toBeDefined();
    expect(ctx).toMatch(/FORWARDED/);
    expect(ctx).toMatch(/CHANNEL CONTEXT/);
    expect(ctx).toMatch(/\[END CHANNEL CONTEXT\]/);
  });

  it("produces a multi-party note for group threads", () => {
    const ctx = buildInboundContext({
      isForward: false,
      isMultiParty: true,
      recipientCount: 4,
    });
    expect(ctx).toBeDefined();
    expect(ctx).toMatch(/4 recipients/);
    expect(ctx).toMatch(/Cc'd/);
  });

  it("combines both notes when a message is both forwarded AND multi-party", () => {
    const ctx = buildInboundContext({
      isForward: true,
      isMultiParty: true,
      recipientCount: 3,
    });
    expect(ctx).toMatch(/FORWARDED/);
    expect(ctx).toMatch(/3 recipients/);
  });

  it("warns the agent about ignored inbound attachments (Phase 4.4)", () => {
    const ctx = buildInboundContext(
      { isForward: false, isMultiParty: false, recipientCount: 1 },
      [
        { filename: "report.pdf", sizeBytes: 1024 * 200 },
        { filename: "image.png", sizeBytes: 1024 * 50, contentType: "image/png" },
      ],
    );
    expect(ctx).toBeDefined();
    expect(ctx).toMatch(/CHANNEL CONTEXT/);
    expect(ctx).toMatch(/2 file\(s\)/);
    expect(ctx).toMatch(/report\.pdf/);
    expect(ctx).toMatch(/image\.png/);
    // The honest-failure framing must name the threat AND tell the
    // agent not to confabulate having read the attachments.
    expect(ctx).toMatch(/prompt-injection/i);
    expect(ctx).toMatch(/Do NOT pretend/);
  });

  it("truncates the attachment list at 5 with an 'and N more' overflow", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      filename: `f${i}.bin`,
      sizeBytes: 100,
    }));
    const ctx = buildInboundContext(
      { isForward: false, isMultiParty: false, recipientCount: 1 },
      many,
    );
    expect(ctx).toBeDefined();
    expect(ctx).toMatch(/8 file\(s\)/);
    expect(ctx).toMatch(/and 3 more/);
    // Files 0-4 are listed; 5-7 are not named individually
    expect(ctx).toMatch(/f0\.bin/);
    expect(ctx).toMatch(/f4\.bin/);
    expect(ctx).not.toMatch(/f5\.bin/);
    expect(ctx).not.toMatch(/f7\.bin/);
  });

  it("returns undefined when there are no attachments AND no other notes", () => {
    const ctx = buildInboundContext(
      { isForward: false, isMultiParty: false, recipientCount: 1 },
      [],
    );
    expect(ctx).toBeUndefined();
  });
});

describe("extractIgnoredInboundAttachments (Phase 4.4)", () => {
  const { extractIgnoredInboundAttachments } = _internal;

  it("returns an empty list when mailparser found nothing", () => {
    expect(extractIgnoredInboundAttachments(undefined)).toEqual([]);
    expect(extractIgnoredInboundAttachments([])).toEqual([]);
  });

  it("preserves filename, size, and contentType when present", () => {
    const out = extractIgnoredInboundAttachments([
      { filename: "report.pdf", size: 2048, contentType: "application/pdf" },
    ]);
    expect(out).toEqual([
      { filename: "report.pdf", sizeBytes: 2048, contentType: "application/pdf" },
    ]);
  });

  it("falls back to content.length when size is missing or zero", () => {
    const out = extractIgnoredInboundAttachments([
      { filename: "x.bin", size: 0, content: { length: 512 } },
      { filename: "y.bin", content: { length: 1024 } },
    ]);
    expect(out[0]?.sizeBytes).toBe(512);
    expect(out[1]?.sizeBytes).toBe(1024);
  });

  it("synthesizes a stable name when filename is missing or whitespace", () => {
    const out = extractIgnoredInboundAttachments([
      { size: 100 },
      { filename: "   ", size: 200 },
      { filename: "named.txt", size: 300 },
    ]);
    expect(out[0]?.filename).toBe("attachment_1");
    expect(out[1]?.filename).toBe("attachment_2");
    expect(out[2]?.filename).toBe("named.txt");
  });

  it("omits contentType from the output when source is empty", () => {
    const out = extractIgnoredInboundAttachments([
      { filename: "a.bin", size: 1, contentType: "" },
      { filename: "b.bin", size: 1 },
    ]);
    expect(out[0]).not.toHaveProperty("contentType");
    expect(out[1]).not.toHaveProperty("contentType");
  });
});

describe("wasAgentInTo (Phase 4.5)", () => {
  const { wasAgentInTo } = _internal;

  it("true when agent is the only recipient on To", () => {
    expect(
      wasAgentInTo(
        { value: [{ address: "agent@example.com" }] },
        "agent@example.com",
      ),
    ).toBe(true);
  });

  it("true when agent is one of several on To", () => {
    expect(
      wasAgentInTo(
        {
          value: [
            { address: "alice@example.com" },
            { address: "agent@example.com" },
            { address: "bob@example.com" },
          ],
        },
        "agent@example.com",
      ),
    ).toBe(true);
  });

  it("false when agent is NOT on To (the cc-only case)", () => {
    expect(
      wasAgentInTo(
        {
          value: [
            { address: "alice@example.com" },
            { address: "bob@example.com" },
          ],
        },
        "agent@example.com",
      ),
    ).toBe(false);
  });

  it("treats empty / missing To as direct (cannot prove otherwise)", () => {
    expect(wasAgentInTo(undefined, "agent@example.com")).toBe(true);
    expect(wasAgentInTo({ value: [] }, "agent@example.com")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      wasAgentInTo(
        { value: [{ address: "Agent@Example.COM" }] },
        "agent@example.com",
      ),
    ).toBe(true);
  });
});

describe("isAddressedByName (Phase 4.5)", () => {
  const { isAddressedByName } = _internal;

  it("true when the full agent address is in the body", () => {
    expect(
      isAddressedByName("status update", "crabmeat@example.com what's up?", "crabmeat@example.com"),
    ).toBe(true);
  });

  it("true when the full agent address is in the subject", () => {
    expect(
      isAddressedByName("question for crabmeat@example.com", "see body", "crabmeat@example.com"),
    ).toBe(true);
  });

  it("true on Slack-style @local mention (\\b matches @-boundary)", () => {
    expect(
      isAddressedByName("status thread", "Hey @crabmeat, can you weigh in?", "crabmeat@example.com"),
    ).toBe(true);
  });

  it("true on bare local-part used as a name", () => {
    expect(
      isAddressedByName("status", "Crabmeat — please summarize the chain.", "crabmeat@example.com"),
    ).toBe(true);
  });

  it("false when the body never names the agent", () => {
    expect(
      isAddressedByName("planning", "Alice and Bob, please discuss timelines.", "crabmeat@example.com"),
    ).toBe(false);
  });

  it("false on a substring match without a word boundary", () => {
    // "decrabmeat" should NOT trigger the local-part match for "crabmeat"
    expect(
      isAddressedByName("status", "We need to decrabmeatify the index.", "crabmeat@example.com"),
    ).toBe(false);
  });

  it("matches case-insensitively (subject + body)", () => {
    expect(
      isAddressedByName("CRABMEAT please reply", "no body needed", "crabmeat@example.com"),
    ).toBe(true);
  });

  it("returns false on empty inputs (defensive)", () => {
    expect(isAddressedByName("", "", "crabmeat@example.com")).toBe(false);
    expect(isAddressedByName("anything", "anywhere", "")).toBe(false);
  });
});

describe("emailImapConnectorConfigSchema replyOnlyWhenAddressed (Phase 4.5)", () => {
  function base() {
    return {
      user: "agent@example.com",
      password: "abcdefghijklmnop",
      allowFromAddresses: ["me@example.com"],
    };
  }

  it("defaults to true (skip CC'd inbounds unless addressed)", () => {
    const parsed = emailImapConnectorConfigSchema.parse(base());
    expect(parsed.replyOnlyWhenAddressed).toBe(true);
  });

  it("accepts an explicit false to fall back to legacy reply-to-everything", () => {
    const parsed = emailImapConnectorConfigSchema.parse({
      ...base(),
      replyOnlyWhenAddressed: false,
    });
    expect(parsed.replyOnlyWhenAddressed).toBe(false);
  });
});

describe("computeThreadRoot", () => {
  it("returns the messageId when there are no References (start of a chain)", () => {
    expect(computeThreadRoot(undefined, "<m1@x>")).toBe("<m1@x>");
  });

  it("returns the FIRST id of a References array (the thread root)", () => {
    expect(computeThreadRoot(["<root@x>", "<r1@x>", "<r2@x>"], "<r3@x>")).toBe(
      "<root@x>",
    );
  });

  it("returns the FIRST id of a space-separated References STRING", () => {
    expect(computeThreadRoot("<root@x> <r1@x> <r2@x>", "<r3@x>")).toBe(
      "<root@x>",
    );
  });

  it("ignores empty / whitespace entries when picking the first", () => {
    expect(computeThreadRoot(["", "<root@x>", "<r1@x>"], "<r2@x>")).toBe(
      "<root@x>",
    );
    expect(computeThreadRoot("   \n  <root@x>  <r1@x>", "<r2@x>")).toBe(
      "<root@x>",
    );
  });

  it("falls back to messageId if References is present but empty", () => {
    expect(computeThreadRoot([], "<m1@x>")).toBe("<m1@x>");
    expect(computeThreadRoot("", "<m1@x>")).toBe("<m1@x>");
  });

  it("returns undefined when neither References nor messageId is present", () => {
    expect(computeThreadRoot(undefined, undefined)).toBeUndefined();
    expect(computeThreadRoot([], undefined)).toBeUndefined();
  });

  it("makes every message in the same thread share one root", () => {
    // Anchor (no References, just its own Message-Id):
    const m0 = computeThreadRoot(undefined, "<m0@x>");
    // First reply: References = <m0@x>, own id = <m1@x>
    const m1 = computeThreadRoot(["<m0@x>"], "<m1@x>");
    // Third-deep reply: References = <m0@x> <m1@x>, own id = <m2@x>
    const m2 = computeThreadRoot(["<m0@x>", "<m1@x>"], "<m2@x>");
    expect(m0).toBe(m1);
    expect(m1).toBe(m2);
  });
});

describe("selectInboundBody", () => {
  it("strips quoted history for direct (non-forward) replies", () => {
    const body = "My reply.\n\nOn Tue, X wrote:\n> old quoted text";
    expect(selectInboundBody(body, false)).toBe("My reply.");
  });

  it("preserves a Gmail-style forwarded body verbatim (minus trim)", () => {
    // The pseudo-header block inside the forwarded section trips the
    // 3-headers-in-5-lines heuristic in stripQuotedReply. Forward mode
    // must skip that strip so the agent sees the forwarded content.
    const body = [
      "Take a look at this and give me a one-paragraph summary.",
      "",
      "---------- Forwarded message ---------",
      "From: Director <director@example.com>",
      "Date: Wed, Apr 23, 2026 at 9:02 AM",
      "Subject: heads up",
      "To: Cid <me@example.com>",
      "",
      "Hey -- two things for next week:",
      "",
      "1. Need the Q2 forecast spreadsheet by EOD Tuesday.",
      "2. Board wants a one-pager on the Phase 4 progress.",
    ].join("\n");
    const out = selectInboundBody(body, true);
    expect(out).toContain("Q2 forecast spreadsheet");
    expect(out).toContain("Phase 4 progress");
    expect(out).toContain("From: Director");
  });

  it("trims leading/trailing whitespace on forwarded bodies", () => {
    expect(selectInboundBody("\n\n  hello world  \n\n", true)).toBe(
      "hello world",
    );
  });

  it("control: same forwarded body WOULD be cut by stripQuotedReply", () => {
    // Locks in WHY the conditional skip exists. If this assertion ever
    // flips (because stripQuotedReply got smarter about forwards), the
    // selectInboundBody branching can be revisited.
    const body = [
      "Take a look.",
      "",
      "From: Director <director@example.com>",
      "Subject: heads up",
      "To: Cid <me@example.com>",
      "",
      "Real forwarded content here.",
    ].join("\n");
    expect(selectInboundBody(body, false)).not.toContain(
      "Real forwarded content",
    );
  });
});

describe("nodemailer wire format for thread headers", () => {
  // These tests catch the failure mode where buildThreadHeaders looks
  // right in unit tests but the actual SMTP-bound RFC822 bytes are
  // wrong (wrong field name, missing angle brackets, swallowed by a
  // spread, etc.). Uses nodemailer's stream-transport so we can read
  // exactly what would have gone on the wire.
  async function rfc822For(
    threadHeaders: ReturnType<typeof buildThreadHeaders>,
  ): Promise<string> {
    const t = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "unix",
    });
    const info = await t.sendMail({
      from: "agent@example.com",
      to: "user@example.com",
      subject: "Re: hi",
      text: "hello",
      ...(threadHeaders ?? {}),
    });
    return (info.message as Buffer).toString("utf8");
  }

  it("emits In-Reply-To and References headers with angle brackets", async () => {
    const headers = buildThreadHeaders("<root@example.com>", [
      "<root@example.com>",
    ]);
    const raw = await rfc822For(headers);
    expect(raw).toMatch(/^In-Reply-To: <root@example\.com>/m);
    expect(raw).toMatch(/^References: <root@example\.com>/m);
  });

  it("emits the full chain in References for a multi-hop thread", async () => {
    const headers = buildThreadHeaders("<m4@x>", [
      "<m1@x>",
      "<m2@x>",
      "<m3@x>",
    ]);
    const raw = await rfc822For(headers);
    expect(raw).toMatch(/^In-Reply-To: <m4@x>/m);
    // Each id space-separated, all wrapped in angle brackets, single line.
    expect(raw).toMatch(/^References: <m1@x> <m2@x> <m3@x> <m4@x>/m);
  });

  it("re-wraps inputs that arrive WITHOUT angle brackets (defense in depth)", async () => {
    // mailparser normally adds angle brackets; nodemailer also re-wraps
    // missing ones. This locks in that contract: even if upstream
    // changes, the wire format stays right.
    const headers = buildThreadHeaders("bare-id@x", ["bare-1@x", "bare-2@x"]);
    const raw = await rfc822For(headers);
    expect(raw).toMatch(/^In-Reply-To: <bare-id@x>/m);
    expect(raw).toMatch(/^References: <bare-1@x> <bare-2@x> <bare-id@x>/m);
  });

  it("emits NO In-Reply-To / References when threadHeaders is undefined", async () => {
    // Inbound with no Message-Id at all — threading is impossible, and
    // we MUST NOT emit a half-formed header that a strict client rejects.
    const raw = await rfc822For(undefined);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw).not.toMatch(/^References:/m);
  });

  it("auto-generates a syntactically valid Message-ID for the outbound", async () => {
    // Threading depends on the agent's outbound having a stable, valid
    // Message-ID for downstream replies to point back at. Catch the
    // regression where nodemailer's Message-ID generator produces
    // something bracketless or with a bare hostname.
    const raw = await rfc822For(buildThreadHeaders("<root@x>", undefined));
    const match = raw.match(/^Message-ID: (.+)$/m);
    expect(match).not.toBeNull();
    const value = match![1]!.trim();
    expect(value.startsWith("<")).toBe(true);
    expect(value.endsWith(">")).toBe(true);
    expect(value).toMatch(/@/);
  });
});

describe("emailImapConnectorConfigSchema", () => {
  function base() {
    return {
      user: "crabmeat.test@gmail.com",
      password: "abcdefghijklmnop",
      allowFromAddresses: ["me@example.com"],
    };
  }

  it("parses with sensible Gmail defaults", () => {
    const parsed = emailImapConnectorConfigSchema.parse(base());
    expect(parsed.imapHost).toBe("imap.gmail.com");
    expect(parsed.imapPort).toBe(993);
    expect(parsed.smtpHost).toBe("smtp.gmail.com");
    expect(parsed.smtpPort).toBe(587);
    expect(parsed.pollIntervalMs).toBe(30_000);
    expect(parsed.mailbox).toBe("INBOX");
    expect(parsed.id).toBe("email-imap");
  });

  it("requires user/password/allowFromAddresses", () => {
    expect(() => emailImapConnectorConfigSchema.parse({})).toThrow();
    expect(() =>
      emailImapConnectorConfigSchema.parse({
        user: "x@y.com",
        password: "p",
        allowFromAddresses: [], // empty array is rejected
      }),
    ).toThrow();
  });

  it("rejects invalid email addresses", () => {
    expect(() =>
      emailImapConnectorConfigSchema.parse({
        user: "not-an-email",
        password: "p",
        allowFromAddresses: ["me@example.com"],
      }),
    ).toThrow();
  });

  it("accepts override of poll interval and mailbox", () => {
    const parsed = emailImapConnectorConfigSchema.parse({
      ...base(),
      pollIntervalMs: 60_000,
      mailbox: "Crabmeat",
    });
    expect(parsed.pollIntervalMs).toBe(60_000);
    expect(parsed.mailbox).toBe("Crabmeat");
  });

  it("accepts outboundTo for proactive message_send email delivery", () => {
    const parsed = emailImapConnectorConfigSchema.parse({
      ...base(),
      outboundTo: ["owner@example.com"],
    });
    expect(parsed.outboundTo).toEqual(["owner@example.com"]);
  });

  it("clamps pollIntervalMs above the floor and below the ceiling", () => {
    expect(() =>
      emailImapConnectorConfigSchema.parse({ ...base(), pollIntervalMs: 1_000 }),
    ).toThrow();
    expect(() =>
      emailImapConnectorConfigSchema.parse({ ...base(), pollIntervalMs: 999_999 }),
    ).toThrow();
  });
});

describe("email-imap outbound connector registration", () => {
  it("registers a message_send outbound connector while started", async () => {
    _resetOutboundRegistry();
    const sent: Array<Record<string, unknown>> = [];
    class FakeImap {
      async connect() {}
      async logout() {}
    }
    const connector = createEmailImapConnector({
      user: "agent@example.com",
      password: "app-password",
      allowFromAddresses: ["owner@example.com"],
      outboundTo: ["notify@example.com"],
      pollIntervalMs: 30_000,
      imapFactory: FakeImap as never,
      smtpFactory: (() =>
        ({
          sendMail: async (opts: Record<string, unknown>) => {
            sent.push(opts);
            return { messageId: "<sent@example.com>" };
          },
          close: () => {},
        }) as never) as never,
    });

    await connector.start(async () => ({ body: "unused" }));
    const outbound = getOutboundConnector("email-imap");
    expect(outbound).toBeDefined();

    const result = await outbound!.deliver({
      sessionKey: "s1",
      content: "Done.",
      killUrl: "https://example.com/kill?t=abc",
      reason: "task complete",
    });
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["notify@example.com"]);
    expect(String(sent[0]!.subject)).toContain("task complete");
    expect(String(sent[0]!.text)).toContain("Done.");
    expect(String(sent[0]!.text)).toContain("https://example.com/kill?t=abc");

    await connector.stop();
    expect(getOutboundConnector("email-imap")).toBeUndefined();
  });
});

describe("parseAuthenticationResults — RT-2026-04-30-003", () => {
  function headersFrom(value: unknown): Map<string, unknown> {
    const m = new Map<string, unknown>();
    m.set("authentication-results", value);
    return m;
  }

  it("returns failed=false when no Authentication-Results header is present", () => {
    const out = parseAuthenticationResults(new Map());
    expect(out.failed).toBe(false);
    expect(out.verdicts).toEqual({});
  });

  it("returns failed=false on a clean spf=pass dkim=pass dmarc=pass", () => {
    const line = "mx.google.com; spf=pass smtp.mailfrom=alice@example.com; dkim=pass header.d=example.com; dmarc=pass";
    const out = parseAuthenticationResults(headersFrom(line));
    expect(out.failed).toBe(false);
    expect(out.spf).toBe("pass");
    expect(out.dkim).toBe("pass");
    expect(out.dmarc).toBe("pass");
  });

  it("flags failed=true on spf=fail (likely spoof)", () => {
    const line = "mx.google.com; spf=fail smtp.mailfrom=alice@example.com; dkim=none; dmarc=fail";
    const out = parseAuthenticationResults(headersFrom(line));
    expect(out.failed).toBe(true);
    expect(out.spf).toBe("fail");
    expect(out.dmarc).toBe("fail");
  });

  it("flags failed=true on dkim=fail alone", () => {
    const line = "mx.google.com; spf=pass; dkim=fail (signature did not verify); dmarc=none";
    const out = parseAuthenticationResults(headersFrom(line));
    expect(out.failed).toBe(true);
    expect(out.dkim).toBe("fail");
  });

  it("treats softfail / temperror / none as NOT-failed (gray zone)", () => {
    // Common shape for forwarded mail or list servers — SPF can soft-fail
    // because the relay isn't in the original SPF record. Don't drop these.
    const line = "mx.google.com; spf=softfail; dkim=temperror; dmarc=none";
    const out = parseAuthenticationResults(headersFrom(line));
    expect(out.failed).toBe(false);
    expect(out.spf).toBe("softfail");
    expect(out.dkim).toBe("temperror");
  });

  it("handles repeated header (multi-hop forward) — first-wins per method", () => {
    // mailparser exposes a repeated header as an array. The first hop's
    // verdict is the one closest to the receiving MTA — that's what we
    // want to trust, not whatever a later forwarder claimed.
    const lines = [
      "mx.google.com; spf=pass; dkim=pass; dmarc=pass",
      "relay.example.com; spf=fail",
    ];
    const out = parseAuthenticationResults(headersFrom(lines));
    expect(out.spf).toBe("pass");
    expect(out.failed).toBe(false);
  });

  it("returns failed=false when the header is malformed / unparseable", () => {
    const out = parseAuthenticationResults(headersFrom("garbage data with no kv pairs"));
    expect(out.failed).toBe(false);
    expect(out.verdicts).toEqual({});
  });
});
