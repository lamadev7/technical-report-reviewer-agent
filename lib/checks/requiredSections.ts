import type { Check, RuleIssue } from "./types";

const HEADING_REGEX = /^\s*(?:(?:\d+(?:\.\d+)*\.?\s+)|(?:[A-Z][A-Z\s/&\-]{2,}$))(.+)$/gm;
const COMMON_SECTIONS = [
  "Abstract",
  "Introduction",
  "Background",
  "Methodology",
  "Methods",
  "Results",
  "Discussion",
  "Conclusion",
  "References",
  "Bibliography",
];

function extractHeadings(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    // Numbered heading like "1. Introduction" or "2.3 Methods"
    const numbered = /^\d+(?:\.\d+)*\.?\s+(.+?)\s*$/.exec(t);
    if (numbered) {
      out.add(numbered[1].toLowerCase());
      continue;
    }
    // ALL-CAPS heading
    if (/^[A-Z][A-Z\s/&\-]{2,}$/.test(t) && t.length < 80) {
      out.add(t.toLowerCase());
    }
  }
  return [...out];
}

function gatherExpectedSections(templates: Array<{ plainText: string }>): string[] {
  const set = new Set<string>();
  for (const t of templates) for (const h of extractHeadings(t.plainText)) set.add(h);
  // Always also check the common-sections list — many templates omit them but
  // graders still expect them.
  for (const c of COMMON_SECTIONS) set.add(c.toLowerCase());
  return [...set];
}

export const requiredSectionsCheck: Check = ({ plainText, templates }) => {
  if (!templates.length) return [];
  const expected = gatherExpectedSections(templates);
  const reportHeadings = new Set(extractHeadings(plainText));
  const reportLower = plainText.toLowerCase();

  const snippet = plainText.slice(0, 80).trim() || "(start)";
  const endOffset = Math.min(snippet.length, plainText.length);

  // Emit one CRITICAL issue per missing section so the reviewer sees each
  // template requirement as its own actionable row. The marking pipeline then
  // applies the FORMAT/COMPLETENESS weight per item.
  const issues: RuleIssue[] = [];
  for (const e of expected) {
    if (reportHeadings.has(e)) continue;
    if (reportLower.includes(e)) continue;
    // Title-case the heading for the description so the row reads cleanly.
    const titled = e.replace(/\b\w/g, (c) => c.toUpperCase());
    issues.push({
      startOffset: 0,
      endOffset,
      quotedText: snippet,
      severity: "CRITICAL",
      category: "FORMAT",
      shortDescription: `Template requires a "${titled}" section — not found in the report.`,
    });
  }
  return issues;
};
