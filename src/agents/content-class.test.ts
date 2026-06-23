import { describe, it, expect } from "vitest";
import { classifyContent, isAllowedToReroute } from "./content-class.js";

describe("classifyContent", () => {
  describe("user-tag override", () => {
    it("honors an explicit tag", () => {
      const result = classifyContent("anything at all", "adult-creative");
      expect(result.contentClass).toBe("adult-creative");
      expect(result.source).toBe("user-tag");
    });

    it("trims whitespace on the tag", () => {
      const result = classifyContent("x", "  nsfw-search  ");
      expect(result.contentClass).toBe("nsfw-search");
    });

    it("falls through an empty tag to keyword scan", () => {
      const result = classifyContent("find a strip club nearby", "");
      expect(result.source).toBe("keyword");
      expect(result.contentClass).toBe("nsfw-search");
    });

    it("user-tag beats keyword when both present", () => {
      const result = classifyContent("find a strip club", "security-research");
      expect(result.source).toBe("user-tag");
      expect(result.contentClass).toBe("security-research");
    });
  });

  describe("keyword heuristic", () => {
    it("catches the motivating 'strip club' example", () => {
      const result = classifyContent("Find me a strip club near me");
      expect(result.contentClass).toBe("nsfw-search");
      expect(result.matchedKeyword).toBe("strip club");
    });

    it("is case-insensitive", () => {
      const result = classifyContent("WRITE ME AN EROTIC STORY");
      expect(result.contentClass).toBe("adult-creative");
    });

    it("classifies pentest / security research", () => {
      expect(
        classifyContent("generate a reverse shell for this CTF").contentClass,
      ).toBe("security-research");
    });

    it("classifies substance-info / harm-reduction", () => {
      expect(
        classifyContent("What's the drug interaction between X and Y?")
          .contentClass,
      ).toBe("substance-info");
    });
  });

  describe("no match", () => {
    it("returns null for normal prompts", () => {
      const result = classifyContent("What is the capital of France?");
      expect(result.contentClass).toBeNull();
      expect(result.source).toBe("none");
    });

    it("does not falsely match broad words like 'club' alone", () => {
      // "book club" shouldn't map to nsfw-search — we ship specific
      // multi-word phrases only, not single broad words.
      const result = classifyContent("Recommend a book club to join");
      expect(result.contentClass).toBeNull();
    });

    it("does not match 'adult' as a standalone word", () => {
      const result = classifyContent(
        "Write an essay about adult responsibilities",
      );
      expect(result.contentClass).toBeNull();
    });
  });
});

describe("isAllowedToReroute", () => {
  it("blocks unclassified requests", () => {
    expect(
      isAllowedToReroute(
        { contentClass: null, source: "none" },
        ["adult-creative"],
      ),
    ).toBe(false);
  });

  it("permits classified + allowlisted", () => {
    expect(
      isAllowedToReroute(
        { contentClass: "adult-creative", source: "keyword" },
        ["adult-creative", "nsfw-search"],
      ),
    ).toBe(true);
  });

  it("blocks classified but NOT in allowlist", () => {
    // The key safety point — even if the classifier matches, if the
    // class isn't on the user's allowlist, we don't reroute.
    expect(
      isAllowedToReroute(
        { contentClass: "security-research", source: "keyword" },
        ["adult-creative"],
      ),
    ).toBe(false);
  });

  it("empty allowlist blocks everything", () => {
    expect(
      isAllowedToReroute(
        { contentClass: "adult-creative", source: "user-tag" },
        [],
      ),
    ).toBe(false);
  });
});
