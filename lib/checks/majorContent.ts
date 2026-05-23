// Shared "major content" extraction + word count. Pure function — safe to
// import from both the server-side rule pass and the client-side UI badge so
// the two surfaces always agree on the same number.

// A TOC entry looks like `1. Introduction .......... 7` — leader dots / dashes /
// tabs followed by a small page number. Skip those when locating the real
// section heading, otherwise we slice from TOC-to-TOC and miss the body.
function isTocLine(line: string): boolean {
  return /(?:[.…·\-_\t]{3,}|\s{4,})\s*\d{1,4}\s*$/.test(line);
}

// Find every occurrence of a heading regex that is on its own line (or
// numbered prefix) AND not a TOC entry. Returns absolute offsets.
function findHeadingOffsets(plain: string, re: RegExp): number[] {
  const out: number[] = [];
  const lines = plain.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (re.test(line) && !isTocLine(line)) out.push(offset);
    offset += line.length + 1; // +1 for the consumed "\n"
  }
  return out;
}

export function majorContentText(plain: string): string {
  // Heading line patterns. Tolerate `Introduction`, `5. Introduction`,
  // `5.Introduction`. Anchor at line start so we don't match `In introduction`.
  const introRe = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?introduction\s*$/i;
  const conclRe = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?conclusions?\s*$/i;

  const introOffsets = findHeadingOffsets(plain, introRe);
  const conclOffsets = findHeadingOffsets(plain, conclRe);

  let start = 0;
  let end = plain.length;
  if (introOffsets.length) start = introOffsets[0];
  // Pick the first conclusion heading that comes AFTER the introduction we
  // settled on — guards against an out-of-order heading earlier in the doc.
  if (conclOffsets.length) {
    const after = conclOffsets.find((o) => o > start);
    if (after !== undefined) end = after;
  }
  let text = plain.slice(start, end);

  // Drop bullet / numbered-list lines from whatever range remains.
  text = text
    .split("\n")
    .filter((line) => !/^\s*([\-*•]|\d+\.)\s+/.test(line))
    .join("\n");
  return text;
}

export function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

export function countMajorWords(plain: string): number {
  return countWords(majorContentText(plain));
}
