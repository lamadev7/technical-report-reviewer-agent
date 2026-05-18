import type { Check, RuleIssue } from "./types";

// Sections that are structural or scaffolding — skip the depth check on them.
const SKIP_HEADINGS = new Set([
  "abstract", "table of contents", "contents", "list of figures", "list of tables",
  "references", "bibliography", "appendix", "appendices", "acknowledgements",
  "acknowledgments", "declaration", "dedication", "title", "cover",
]);

const MIN_WORDS_PER_SECTION = 80;
const MAX_ISSUES = 12;

type Heading = { title: string; offset: number };

function detectHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  const lines = text.split("\n");
  let off = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { off += line.length + 1; continue; }
    const numbered = /^\d+(?:\.\d+)*\.?\s+(.+?)\s*$/.exec(t);
    if (numbered && numbered[1].length < 80) {
      out.push({ title: numbered[1].trim(), offset: off });
    } else if (/^[A-Z][A-Z\s/&\-]{2,}$/.test(t) && t.length < 80) {
      out.push({ title: t, offset: off });
    }
    off += line.length + 1;
  }
  return out;
}

function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

export const sectionDepthCheck: Check = ({ plainText }) => {
  const headings = detectHeadings(plainText);
  if (headings.length < 2) return [];

  const issues: RuleIssue[] = [];
  for (let i = 0; i < headings.length && issues.length < MAX_ISSUES; i++) {
    const h = headings[i];
    if (SKIP_HEADINGS.has(h.title.toLowerCase())) continue;
    const next = headings[i + 1];
    const body = plainText.slice(h.offset + h.title.length, next ? next.offset : plainText.length);
    const wc = countWords(body);
    if (wc >= MIN_WORDS_PER_SECTION) continue;

    const start = h.offset;
    const end = Math.min(plainText.length, h.offset + h.title.length);
    issues.push({
      startOffset: start,
      endOffset: end,
      quotedText: h.title,
      severity: wc < 20 ? "CRITICAL" : "MAJOR",
      category: "SECTION_QUALITY",
      shortDescription: `Section "${h.title}" has only ${wc} words — likely shallow or heading-only.`,
    });
  }
  return issues;
};
