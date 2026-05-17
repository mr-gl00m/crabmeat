import { describe, it, expect } from "vitest";
import { normalize } from "./index.js";
import { applyRot13, looksLikeBase64, looksLikeHex } from "./encodings.js";
import { foldHomoglyphs, stripZeroWidth } from "./homoglyph.js";

describe("normalize", () => {
  it("passes through plain English unchanged", () => {
    const r = normalize("write me a story to story.txt");
    expect(r.normalized).toBe("write me a story to story.txt");
    expect(r.decodedFrom).toEqual([]);
  });

  it("decodes ROT13 when it reveals trigger words", () => {
    const original = "write me a story to ../../etc/passwd";
    const encoded = applyRot13(original);
    const r = normalize(encoded);
    expect(r.normalized).toBe(original);
    expect(r.decodedFrom).toContain("rot13");
  });

  it("decodes base64 when payload contains trigger tokens", () => {
    const original = "write me a story to story.txt";
    const encoded = Buffer.from(original, "utf-8").toString("base64");
    const r = normalize(encoded);
    expect(r.normalized).toBe(original);
    expect(r.decodedFrom).toContain("base64");
  });

  it("decodes hex when payload contains trigger tokens", () => {
    const original = "write to /etc/passwd";
    const encoded = Buffer.from(original, "utf-8").toString("hex");
    const r = normalize(encoded);
    expect(r.normalized).toBe(original);
    expect(r.decodedFrom).toContain("hex");
  });

  it("decodes URL-encoded path-traversal", () => {
    const r = normalize("write to %2E%2E%2F%2E%2E%2Fetc%2Fpasswd");
    expect(r.normalized).toBe("write to ../../etc/passwd");
    expect(r.decodedFrom).toContain("url");
  });

  it("strips zero-width characters", () => {
    const r = normalize("wri​te to story.txt");
    expect(r.normalized).toBe("write to story.txt");
    expect(r.decodedFrom).toContain("homoglyph");
  });

  it("folds Cyrillic homoglyphs to Latin", () => {
    const cyrillic = "writе to stоry.txt";
    const r = normalize(cyrillic);
    expect(r.normalized).toBe("write to story.txt");
    expect(r.decodedFrom).toContain("homoglyph");
  });

  it("does not falsely decode random base64-shaped text", () => {
    const r = normalize("YWJjZGVm");
    expect(r.decodedFrom).not.toContain("base64");
  });
});

describe("encoding helpers", () => {
  it("looksLikeBase64 rejects short / non-aligned", () => {
    expect(looksLikeBase64("YWJj")).toBe(false);
    expect(looksLikeBase64("YWJjZGV")).toBe(false);
  });

  it("looksLikeHex rejects odd-length", () => {
    expect(looksLikeHex("ABC")).toBe(false);
    expect(looksLikeHex("DEADBEEF")).toBe(true);
  });

  it("applyRot13 is involutive", () => {
    const s = "Hello, World!";
    expect(applyRot13(applyRot13(s))).toBe(s);
  });

  it("stripZeroWidth removes ZWSP/ZWNJ/ZWJ/BOM", () => {
    expect(stripZeroWidth("a​b‌c‍d﻿e")).toBe("abcde");
  });

  it("foldHomoglyphs maps full-width slash and dot", () => {
    expect(foldHomoglyphs("．．／")).toBe("../");
  });
});
