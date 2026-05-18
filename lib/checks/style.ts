import type { Check, RuleIssue } from "./types";

// write-good is CJS — load lazily so we don't fail on import-time side effects.
let writeGood: ((s: string) => Array<{ index: number; offset: number; reason: string }>) | null = null;

async function getWriteGood() {
  if (!writeGood) {
    const mod: any = await import("write-good");
    writeGood = mod.default || mod;
  }
  return writeGood!;
}

const MAX_ISSUES = 25;

export const styleCheck: Check = async ({ plainText }) => {
  const wg = await getWriteGood();
  const suggestions = wg(plainText) || [];
  const issues: RuleIssue[] = [];
  // Group by reason so we don't drown the user in identical findings.
  const perReason = new Map<string, number>();
  for (const s of suggestions) {
    if (issues.length >= MAX_ISSUES) break;
    const n = perReason.get(s.reason) ?? 0;
    if (n >= 4) continue;
    perReason.set(s.reason, n + 1);

    const start = Math.max(0, s.index);
    const end = Math.min(plainText.length, start + (s.offset || 1));
    const quoted = plainText.slice(start, end);
    if (!quoted.trim()) continue;
    issues.push({
      startOffset: start,
      endOffset: end,
      quotedText: quoted,
      severity: "MAJOR",
      category: "SECTION_QUALITY",
      shortDescription: `Style: "${quoted.slice(0, 40)}" ${s.reason}`,
    });
  }
  return issues;
};
