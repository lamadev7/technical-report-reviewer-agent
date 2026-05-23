import type { Check, RuleIssue } from "./types";

function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

// Trim away sections the rubric explicitly excludes from "major content":
// table of contents, references/bibliography, conclusion, and bullet lists.
// We strip them by header heuristic so the count reflects what the marker
// cares about (intro → critical evaluation).
function majorContentText(plain: string): string {
  let text = plain;
  const cutHeaders = [
    /^[\s\S]*?(?=\n\s*(?:table of contents|contents)\s*\n)/i, // leave nothing before TOC removal
  ];
  // Drop table of contents block — assume it ends at first numbered/major header.
  text = text.replace(/(\n|^)\s*(?:table of contents|contents)\s*\n[\s\S]*?(?=\n\s*(?:abstract|introduction|chapter\s*1|1\.\s)[^\n]*\n)/i, "\n");
  // Drop references / bibliography / appendix from first heading match to end.
  text = text.replace(/\n\s*(?:references|bibliography|works cited|appendix|appendices)\b[\s\S]*$/i, "\n");
  // Drop conclusion section from its heading to end (or to references which is
  // already gone). Conclusion is excluded per the rubric.
  text = text.replace(/\n\s*(?:conclusion|conclusions)\b[\s\S]*$/i, "\n");
  // Drop bullet/numbered list lines (lines that start with -, *, •, or "1.")
  text = text
    .split("\n")
    .filter((line) => !/^\s*([\-*•]|\d+\.)\s+/.test(line))
    .join("\n");
  return text;
}

export const wordCountCheck: Check = ({ plainText, wordCountMin, wordCountMax }) => {
  const issues: RuleIssue[] = [];
  if (wordCountMin <= 0 && wordCountMax <= 0) return issues;
  const words = countWords(majorContentText(plainText));
  const snippet = plainText.slice(0, 80).trim() || "(empty)";
  const endOffset = Math.min(snippet.length, plainText.length);
  if (wordCountMin > 0 && words < wordCountMin) {
    issues.push({
      startOffset: 0,
      endOffset,
      quotedText: snippet,
      severity: "CRITICAL",
      category: "COMPLETENESS",
      shortDescription: `Major-content word count ${words} is below required minimum ${wordCountMin}.`,
    });
  }
  if (wordCountMax > 0 && words > wordCountMax) {
    issues.push({
      startOffset: 0,
      endOffset,
      quotedText: snippet,
      severity: "CRITICAL",
      category: "COMPLETENESS",
      shortDescription: `Major-content word count ${words} exceeds allowed maximum ${wordCountMax}.`,
    });
  }
  return issues;
};
