import { prisma } from "@/lib/db";
import type { IssueCategory } from "@prisma/client";

// Hits required before a deletion pattern is treated as a globally-learned
// "don't flag this" hint. Three independent dismissals across any reports is
// a strong-enough signal that it's a recurring false positive (or simply a
// kind of finding the human reviewer never cares about).
export const LEARNED_REJECTION_THRESHOLD = 3;

// Maximum number of patterns to inject into the agent's system prompt. Keeps
// the context window predictable as the corpus grows.
const MAX_LEARNED_LINES = 40;

// Strip leading tags ([under]/[over]), punctuation, dynamic numbers, quoted
// substrings, and casing so semantically-equivalent descriptions collapse to
// the same key. Example:
//   `Likely misspelling: "syste" — try system`
//   `Likely misspelling: "tem" — try item, them`
// both normalize to `likely misspelling`.
export function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    // drop our agent tags
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    // drop quoted-substring contents (the specific token / phrase varies)
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    // drop "— try X, Y, Z" suggestion lists
    .replace(/[—–-]\s*try\s+[^.]*/g, "")
    // drop bare numbers (counts, line refs)
    .replace(/\b\d+(?:\.\d+)?\b/g, "")
    // drop punctuation
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

export async function recordRejections(
  issues: Array<{ shortDescription: string; quotedText: string; category: IssueCategory }>,
): Promise<void> {
  if (!issues.length) return;
  for (const iss of issues) {
    const key = normalizeDescription(iss.shortDescription);
    if (!key) continue;
    try {
      await prisma.learnedRejection.upsert({
        where: { normalizedDesc: key },
        update: { hitCount: { increment: 1 }, sampleDesc: iss.shortDescription.slice(0, 240), sampleQuoted: iss.quotedText.slice(0, 240) },
        create: {
          normalizedDesc: key,
          sampleDesc: iss.shortDescription.slice(0, 240),
          sampleQuoted: iss.quotedText.slice(0, 240),
          category: iss.category,
          hitCount: 1,
        },
      });
    } catch (e: any) {
      console.warn("learned-rejection upsert failed:", e?.message || e);
    }
  }
}

export async function buildLearnedRejectionBlob(): Promise<string> {
  const rows = await prisma.learnedRejection.findMany({
    where: { hitCount: { gte: LEARNED_REJECTION_THRESHOLD } },
    orderBy: { hitCount: "desc" },
    take: MAX_LEARNED_LINES,
  });
  if (!rows.length) return "";
  const lines = rows
    .map((r, i) => `${i + 1}. [${r.category} × ${r.hitCount}] "${r.sampleQuoted.slice(0, 80)}" — ${r.sampleDesc.slice(0, 160)}`)
    .join("\n");
  return [
    "Globally-learned dismissals (the human reviewer has deleted this kind of finding multiple times across past reports — treat them as a hard DO-NOT-FLAG list).",
    "If a candidate finding's description and/or quoted span looks like any pattern below, SKIP IT entirely. Do not invent a different angle on the same problem.",
    "",
    lines,
  ].join("\n");
}
