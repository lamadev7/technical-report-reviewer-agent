import type { Check, RuleIssue } from "./types";
import { countMajorWords } from "./majorContent";

export const wordCountCheck: Check = ({ plainText, wordCountMin, wordCountMax }) => {
  const issues: RuleIssue[] = [];
  if (wordCountMin <= 0 && wordCountMax <= 0) return issues;
  const words = countMajorWords(plainText);
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
