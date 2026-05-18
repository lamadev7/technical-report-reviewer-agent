import type { Check, RuleIssue } from "./types";

const MIN_WORDS = 300;
const SHORT_WORDS = 800;

function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

export const wordCountCheck: Check = ({ plainText }) => {
  const words = countWords(plainText);
  const issues: RuleIssue[] = [];
  const snippet = plainText.slice(0, 80).trim() || "(empty)";
  if (words < MIN_WORDS) {
    issues.push({
      startOffset: 0,
      endOffset: Math.min(snippet.length, plainText.length),
      quotedText: snippet,
      severity: "CRITICAL",
      category: "COMPLETENESS",
      shortDescription: `Report has only ${words} words (minimum ${MIN_WORDS}). Likely incomplete.`,
    });
  } else if (words < SHORT_WORDS) {
    issues.push({
      startOffset: 0,
      endOffset: Math.min(snippet.length, plainText.length),
      quotedText: snippet,
      severity: "MAJOR",
      category: "COMPLETENESS",
      shortDescription: `Report length ${words} words is below typical depth (~${SHORT_WORDS}+).`,
    });
  }
  return issues;
};
