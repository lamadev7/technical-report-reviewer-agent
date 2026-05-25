import type { Check, RuleIssue } from "./types";
import {
  SECTION_GROUPS,
  findGroup,
  extractHeadings,
  tokens,
  normalize,
  type SectionGroup,
} from "@/lib/agent/sectionGroups";

function groupPresent(group: SectionGroup, reportHeadingsNorm: Set<string>, reportLower: string): boolean {
  for (const syn of group.synonyms) {
    const synNorm = normalize(syn);
    if (reportHeadingsNorm.has(synNorm)) return true;
    const synTokens = tokens(synNorm);
    if (synTokens.length) {
      for (const rh of reportHeadingsNorm) {
        const rhTokens = tokens(rh);
        if (synTokens.every((t) => rhTokens.includes(t))) return true;
        if (rhTokens.length && rhTokens.every((t) => synTokens.includes(t))) return true;
      }
    }
    if (synNorm.length >= 5 && reportLower.includes(synNorm)) return true;
  }
  if (group.canonical === "Title and Declaration Sheet") {
    const head = reportLower.slice(0, 8000);
    if (/\b(i hereby declare|i declare that|statement of originality|declaration)\b/.test(head)) return true;
  }
  if (group.canonical === "Cover Page") {
    const head = reportLower.slice(0, 4000);
    if (/\b(submitted by|bachelor of|master of|university of|supervisor)\b/.test(head)) return true;
  }
  return false;
}

function gatherExpectedGroups(templates: Array<{ plainText: string }>): SectionGroup[] {
  const seen = new Set<string>();
  const expected: SectionGroup[] = [];
  for (const t of templates) {
    for (const h of extractHeadings(t.plainText)) {
      const g = findGroup(h);
      if (g && !seen.has(g.canonical)) {
        seen.add(g.canonical);
        expected.push(g);
      }
    }
  }
  return expected;
}

export const requiredSectionsCheck: Check = ({ plainText, templates }) => {
  if (!templates.length) return [];
  const expected = gatherExpectedGroups(templates);
  const reportHeadingsNorm = new Set(extractHeadings(plainText));
  const reportLower = plainText.toLowerCase();

  const snippet = plainText.slice(0, 80).trim() || "(start)";
  const endOffset = Math.min(snippet.length, plainText.length);

  const issues: RuleIssue[] = [];
  for (const g of expected) {
    if (g.optional) continue;
    if (groupPresent(g, reportHeadingsNorm, reportLower)) continue;
    issues.push({
      startOffset: 0,
      endOffset,
      quotedText: snippet,
      severity: "CRITICAL",
      category: "FORMAT",
      shortDescription: `Template requires a "${g.canonical}" section — not found in the report.`,
    });
  }
  return issues;
};

// Re-exported for unit tests + UI components.
export { SECTION_GROUPS, findGroup, extractHeadings, normalize, tokens };
export const __test = { normalize, tokens, findGroup, groupPresent, extractHeadings, SECTION_GROUPS };
