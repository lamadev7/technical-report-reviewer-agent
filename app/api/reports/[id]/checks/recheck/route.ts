import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runAllChecks } from "@/lib/checks";
import { recomputeMarking } from "@/lib/agent/marking";
import { countMajorWords } from "@/lib/checks/majorContent";
import { normalizeDescription, LEARNED_REJECTION_THRESHOLD } from "@/lib/agent/learning";

export const runtime = "nodejs";

// POST — re-run deterministic rule checks for a report and replace its RULE
// issues atomically. Used by the "refresh word count" affordance so the
// reviewer doesn't have to trigger a full agent review just to update the
// word-count rule issue after changing min/max.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.report.findUnique({
    where: { id },
    select: { filename: true, plainText: true, templateId: true, wordCountMin: true, wordCountMax: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const templates = await prisma.kbTemplate.findMany({
    where: report.templateId ? { id: report.templateId } : {},
    select: { name: true, plainText: true },
  });
  const ruleIssues = await runAllChecks({
    plainText: report.plainText,
    filename: report.filename,
    templates,
    wordCountMin: report.wordCountMin,
    wordCountMax: report.wordCountMax,
  });

  // Respect prior dismissals: drop any candidate whose normalized description
  // matches an issue the reviewer already soft-deleted on this report OR a
  // pattern that's crossed the global learned-rejection threshold.
  const [reportDismissed, globalLearned] = await Promise.all([
    prisma.issue.findMany({
      where: { reportId: id, deleted: true },
      select: { shortDescription: true, quotedText: true },
    }),
    prisma.learnedRejection.findMany({
      where: { hitCount: { gte: LEARNED_REJECTION_THRESHOLD } },
      select: { normalizedDesc: true },
    }),
  ]);
  const dismissedKeys = new Set<string>([
    ...reportDismissed.map((i) => normalizeDescription(i.shortDescription)),
    ...globalLearned.map((r) => r.normalizedDesc),
  ]);
  // Also remember the exact (description, quoted) pair so we don't resurrect
  // verbatim duplicates even when the normalized key narrowly misses.
  const dismissedPairs = new Set<string>(
    reportDismissed.map((i) => `${i.shortDescription}::${i.quotedText}`),
  );
  const filteredRuleIssues = ruleIssues.filter((i) => {
    const key = normalizeDescription(i.shortDescription);
    if (key && dismissedKeys.has(key)) return false;
    if (dismissedPairs.has(`${i.shortDescription}::${i.quotedText}`)) return false;
    return true;
  });

  await prisma.$transaction([
    prisma.issue.deleteMany({ where: { reportId: id, source: "RULE", deleted: false } }),
    ...(filteredRuleIssues.length
      ? [prisma.issue.createMany({ data: filteredRuleIssues.map((i) => ({ ...i, reportId: id, source: "RULE" as const })) })]
      : []),
  ]);
  const marking = await recomputeMarking(id);
  const issues = await prisma.issue.findMany({
    where: { reportId: id, deleted: false },
    orderBy: { startOffset: "asc" },
  });
  return NextResponse.json({
    issues,
    marking,
    wordCount: countMajorWords(report.plainText),
  });
}
