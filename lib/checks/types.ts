import type { Severity, IssueCategory } from "@prisma/client";

export type RuleIssue = {
  startOffset: number;
  endOffset: number;
  quotedText: string;
  severity: Severity;
  category: IssueCategory;
  shortDescription: string;
};

export type CheckContext = {
  plainText: string;
  filename: string;
  templates: Array<{ name: string; plainText: string }>;
  wordCountMin: number;
  wordCountMax: number;
};

export type Check = (ctx: CheckContext) => RuleIssue[] | Promise<RuleIssue[]>;
