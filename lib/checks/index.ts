import type { Check, CheckContext, RuleIssue } from "./types";
import { wordCountCheck } from "./wordCount";
import { requiredSectionsCheck } from "./requiredSections";
import { spellingCheck } from "./spelling";
import { styleCheck } from "./style";
import { sectionDepthCheck } from "./sectionDepth";

const CHECKS: Check[] = [wordCountCheck, requiredSectionsCheck, sectionDepthCheck, spellingCheck, styleCheck];

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
