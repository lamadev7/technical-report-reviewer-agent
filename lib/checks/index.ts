import type { Check, CheckContext, RuleIssue } from "./types";
import { wordCountCheck } from "./wordCount";
import { requiredSectionsCheck } from "./requiredSections";
import { sectionDepthCheck } from "./sectionDepth";

// Spelling + style are handled by the agent's grammar-prose skill so findings
// are sentence-context aware. Dictionary-based rules produced too many false
// positives (PDF fragments like "gement"/"ertainty", valid words like
// "biometric"/"technologic", surnames, words used correctly in context).
const CHECKS: Check[] = [wordCountCheck, requiredSectionsCheck, sectionDepthCheck];

export async function runAllChecks(ctx: CheckContext): Promise<RuleIssue[]> {
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      try {
        return await c(ctx);
      } catch (e: any) {
        console.warn(`check ${c.name} failed:`, e?.message || e);
        return [];
      }
    }),
  );
  return results.flat();
}

export type { RuleIssue } from "./types";
