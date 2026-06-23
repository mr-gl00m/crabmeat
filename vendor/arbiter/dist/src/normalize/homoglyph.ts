const HOMOGLYPHS: Record<string, string> = {
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "і": "i",
  "ӏ": "l",
  "А": "A",
  "В": "B",
  "Е": "E",
  "К": "K",
  "М": "M",
  "Н": "H",
  "О": "O",
  "Р": "P",
  "С": "C",
  "Т": "T",
  "Х": "X",
  "α": "a",
  "ο": "o",
  "ρ": "p",
  "υ": "y",
  "ν": "v",
  "Ι": "I",
  "Ο": "O",
  "．": ".",
  "／": "/",
  "＼": "\\",
  "․": ".",
  "⁄": "/",
};

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, "");
}

export function foldHomoglyphs(s: string): string {
  let out = "";
  for (const ch of s) {
    out += HOMOGLYPHS[ch] ?? ch;
  }
  return out;
}

export function normalizeCharset(s: string): string {
  return foldHomoglyphs(stripZeroWidth(s.normalize("NFKC")));
}
