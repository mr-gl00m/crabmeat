// Regression test for BH-2026-05-10-005 (bug-hunt 2026-05-10).
// Invariant: buildReplySubject normalizes localized reply prefixes
// (AW: / Antw: / SV: / VS: / Odp: / Ответ:) to a single English Re:
// prefix. The original code stripped one prefix and prepended Re:, so
// `Re: Re: x`, `AW: Re: foo`, etc. accreted instead of normalizing.
// Fix: loop the prefix strip until none match, then prepend Re: once.
import { describe, it, expect } from "vitest";
import { _internal } from "../src/connectors/email-imap.js";

const { buildReplySubject } = _internal;

function leadingPrefixCount(s: string): number {
  const re = /^\s*(?:re|aw|antw|sv|vs|odp|ответ)\s*:\s*/iu;
  let n = 0;
  let cur = s;
  while (re.test(cur)) {
    cur = cur.replace(re, "");
    n++;
  }
  return n;
}

describe("BH-2026-05-10-005: buildReplySubject must normalize doubled prefixes", () => {
  const CASES: ReadonlyArray<{ input: string; note: string }> = [
    { input: "Re: Re: nested", note: "doubled English prefix" },
    { input: "AW: Re: foo", note: "German prefix wrapping English reply" },
    { input: "Re: AW: foo", note: "English prefix wrapping German reply" },
    { input: "SV: Re: msg", note: "Swedish wrapping English" },
  ];
  for (const { input, note } of CASES) {
    it(`(${note}) buildReplySubject(${JSON.stringify(input)}) → exactly one Re:`, () => {
      const out = buildReplySubject(input);
      const count = leadingPrefixCount(out);
      expect(
        count,
        `expected exactly one leading reply prefix; got ${count} in ${JSON.stringify(out)}.`,
      ).toBe(1);
    });
  }
});
