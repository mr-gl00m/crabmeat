import { describe, it, expect } from "vitest";
import { detectRefusal, RefusalLeadBuffer } from "./refusal-detect.js";

describe("detectRefusal", () => {
  describe("prefix matches", () => {
    it("catches the classic Claude opener", () => {
      const match = detectRefusal("I cannot help with that request.");
      expect(match?.mode).toBe("prefix");
      expect(match?.phrase).toBe("I cannot");
    });

    it("catches 'As an AI language model' lineage", () => {
      const match = detectRefusal("As an AI, I'm not able to do that.");
      expect(match?.mode).toBe("prefix");
    });

    it("catches apologetic decline prefixes", () => {
      const match = detectRefusal("I'm sorry, but I can't assist with this.");
      expect(match?.mode).toBe("prefix");
      expect(match?.phrase).toBe("I'm sorry");
    });

    it("handles leading whitespace without false-negative", () => {
      const match = detectRefusal("   I cannot do that.");
      expect(match?.mode).toBe("prefix");
    });

    it("is case-insensitive", () => {
      const match = detectRefusal("i CANNOT help.");
      expect(match?.mode).toBe("prefix");
    });

    it("catches non-English refusal prefixes", () => {
      expect(detectRefusal("Lo siento, no puedo.")?.mode).toBe("prefix");
      expect(detectRefusal("对不起，我无法做这个。")?.mode).toBe("prefix");
    });

    it("catches Unicode curly apostrophe variants (gpt-oss / Gemini default)", () => {
      // U+2019 (right single quotation mark) — what most LLMs emit instead of
      // ASCII apostrophe. Without quote normalization, this match would slip
      // through every prefix in the list and refusals would reach the user.
      const curly = "I’m sorry, but I can’t help with that.";
      const match = detectRefusal(curly);
      expect(match?.mode).toBe("prefix");
      expect(match?.phrase).toBe("I'm sorry");
    });

    it("catches curly apostrophe in 'I won't' / 'I can't' contractions", () => {
      // Prefix match — "I won't" is in REFUSAL_PREFIXES.
      expect(
        detectRefusal("I won’t do that.")?.mode,
      ).toBe("prefix");
      // Substring match — text doesn't start with a known refusal prefix,
      // and "i can't" lives in the substring list.
      expect(
        detectRefusal("Hmm, looking at this, I can’t actually do that.")?.mode,
      ).toBe("substring");
    });
  });

  describe("substring matches", () => {
    it("catches embedded refusal after a preamble", () => {
      const text = "Thanks for the question — unfortunately I cannot assist.";
      const match = detectRefusal(text);
      expect(match?.mode).toBe("substring");
    });

    it("catches 'goes against my guidelines' style", () => {
      const match = detectRefusal(
        "This request goes against my core programming.",
      );
      expect(match?.mode).toBe("substring");
    });
  });

  describe("non-refusal content", () => {
    it("does not flag normal answers", () => {
      expect(
        detectRefusal("The capital of France is Paris."),
      ).toBeNull();
    });

    it("does not flag empty/whitespace", () => {
      expect(detectRefusal("")).toBeNull();
      expect(detectRefusal("   \n\t  ")).toBeNull();
    });

    it("does not flag code samples", () => {
      expect(
        detectRefusal("```python\nprint('hello')\n```"),
      ).toBeNull();
    });
  });

  describe("known false-positive shapes", () => {
    // These are legit responses that happen to contain substrings that
    // look like refusals. The content-class gate catches these at the
    // reroute-decision stage — this test just documents that substring
    // detection alone is noisy, which is expected and why the gate exists.
    it("fires on 'I cannot overstate' (documented false positive)", () => {
      const match = detectRefusal(
        "I cannot overstate how important this is.",
      );
      expect(match?.mode).toBe("prefix"); // starts with "I cannot"
    });

    it("fires on 'I can't find a strip club' — legit query result", () => {
      // Near-miss for the user's own motivating example. The model is
      // reporting a search result, not refusing. Caught by the detector
      // but should NOT reroute — content-class gate filters this.
      const match = detectRefusal(
        "I can't find any strip clubs within 50 miles of that ZIP code.",
      );
      expect(match?.mode).toBe("substring");
    });
  });
});

describe("RefusalLeadBuffer", () => {
  it("buffers silently while collecting lead", () => {
    const buf = new RefusalLeadBuffer(50);
    expect(buf.feed("hello")).toBe("");
    expect(buf.isDecided).toBe(false);
  });

  it("releases lead on clean detection once full", () => {
    const buf = new RefusalLeadBuffer(20);
    const part = "The answer to your question is ";
    const out = buf.feed(part);
    // Chunk > leadBytes, so auto-decides on first feed.
    expect(buf.isDecided).toBe(true);
    expect(buf.didDetectRefusal).toBe(false);
    expect(out).toBe(part);
  });

  it("swallows lead on refusal detection", () => {
    const buf = new RefusalLeadBuffer(30);
    const refusal = "I cannot help with that request at all.";
    const out = buf.feed(refusal);
    expect(buf.isDecided).toBe(true);
    expect(buf.didDetectRefusal).toBe(true);
    expect(out).toBe("");
  });

  it("passes through subsequent chunks after clean decision", () => {
    const buf = new RefusalLeadBuffer(10);
    buf.feed("abcdefghijklm");
    expect(buf.isDecided).toBe(true);
    expect(buf.feed(" more content")).toBe(" more content");
  });

  it("swallows subsequent chunks after refusal decision", () => {
    const buf = new RefusalLeadBuffer(10);
    buf.feed("I cannot do this.");
    expect(buf.didDetectRefusal).toBe(true);
    expect(buf.feed(" additional refusal text")).toBe("");
  });

  it("forced decide() on short clean response returns the lead", () => {
    const buf = new RefusalLeadBuffer(200);
    buf.feed("Paris.");
    const { refusal, lead } = buf.decide();
    expect(refusal).toBeNull();
    expect(lead).toBe("Paris.");
  });

  it("forced decide() on short refusal returns the match", () => {
    const buf = new RefusalLeadBuffer(200);
    buf.feed("I cannot.");
    const { refusal } = buf.decide();
    expect(refusal?.mode).toBe("prefix");
  });

  it("decide() is idempotent", () => {
    const buf = new RefusalLeadBuffer(200);
    buf.feed("I cannot help.");
    const first = buf.decide();
    const second = buf.decide();
    expect(second.refusal?.phrase).toBe(first.refusal?.phrase);
  });

  it("handles chunk-boundary splits of refusal text", () => {
    // leadBytes=20 ensures the lead fills before we force a decision;
    // the point is that matching works across chunk boundaries, not
    // that short streams auto-decide.
    const buf = new RefusalLeadBuffer(20);
    buf.feed("I ca");
    buf.feed("nnot help");
    buf.feed(" with this request further.");
    expect(buf.didDetectRefusal).toBe(true);
  });
});
