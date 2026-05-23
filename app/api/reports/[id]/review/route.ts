import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { reviewReport } from "@/lib/agent/reviewer";
import { publish, type ReviewStep } from "@/lib/agent/reviewBus";
import { runAllChecks } from "@/lib/checks";
import { normalizeDescription, LEARNED_REJECTION_THRESHOLD } from "@/lib/agent/learning";

export const runtime = "nodejs";
export const maxDuration = 600;

function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const report = await prisma.report.findUnique({
    where: { id },
    select: {
      status: true,
      plainText: true,
      filename: true,
      wordCountMin: true,
      wordCountMax: true,
      templateId: true,
    },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (report.status === "REVIEWING") {
    return NextResponse.json({ status: "REVIEWING", already: true }, { status: 202 });
  }

  const startedAt = new Date();
  const steps: ReviewStep[] = [];

  // STEP 1 — total word count valid.
  const words = countWords(report.plainText);
  const min = report.wordCountMin;
  const max = report.wordCountMax;
  let rangeMsg: string | null = null;
  if (min > 0 && words < min) rangeMsg = `${words} words — below required minimum of ${min}`;
  else if (max > 0 && words > max) rangeMsg = `${words} words — above allowed maximum of ${max}`;
  steps.push({
    name: "Total word count valid",
    status: rangeMsg ? "fail" : "pass",
    detail: rangeMsg || `${words} words (range ${min || "—"} … ${max || "—"})`,
  });

  // STEP 2..N — rule pass (required sections, section depth, word-count rule
  // issue). Each check produces zero or more RuleIssue rows; we map them into
  // visible steps in the UI so the reviewer sees what passed and what failed.
  const templates = await prisma.kbTemplate.findMany({
    where: report.templateId ? { id: report.templateId } : {},
    select: { name: true, plainText: true },
  });
  const ruleIssuesRaw = await runAllChecks({
    plainText: report.plainText,
    filename: report.filename,
    templates,
    wordCountMin: report.wordCountMin,
    wordCountMax: report.wordCountMax,
  });

  // Respect prior dismissals so deleted criticals don't resurface on every
  // recheck. Drop candidates that match per-report soft-deletes or a
  // globally-learned rejection pattern.
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
  const dismissedPairs = new Set<string>(
    reportDismissed.map((i) => `${i.shortDescription}::${i.quotedText}`),
  );
  const ruleIssues = ruleIssuesRaw.filter((i) => {
    const key = normalizeDescription(i.shortDescription);
    if (key && dismissedKeys.has(key)) return false;
    if (dismissedPairs.has(`${i.shortDescription}::${i.quotedText}`)) return false;
    return true;
  });

  const missingSectionIssues = ruleIssues.filter(
    (i) => i.category === "FORMAT" && /Template requires/i.test(i.shortDescription),
  );
  const shallowSectionIssues = ruleIssues.filter(
    (i) => i.category === "SECTION_QUALITY" && /shallow|heading-only|only \d+ words/i.test(i.shortDescription),
  );
  steps.push({
    name: "All template-required sections present",
    status: missingSectionIssues.length === 0 ? "pass" : "fail",
    detail:
      missingSectionIssues.length === 0
        ? "Every heading the template requires was found in the report"
        : `${missingSectionIssues.length} required section(s) missing: ` +
          missingSectionIssues
            .slice(0, 5)
            .map((i) => i.shortDescription.match(/"([^"]+)"/)?.[1] || i.shortDescription)
            .join(", ") +
          (missingSectionIssues.length > 5 ? "…" : ""),
  });
  steps.push({
    name: "Section depth sufficient",
    status: shallowSectionIssues.length === 0 ? "pass" : "fail",
    detail:
      shallowSectionIssues.length === 0
        ? "No heading-only / one-line sections detected"
        : `${shallowSectionIssues.length} section(s) flagged as shallow`,
  });

  // Replace prior RULE issues with this run's set so re-runs don't pile up duplicates.
  await prisma.$transaction([
    prisma.issue.deleteMany({ where: { reportId: id, source: "RULE", deleted: false } }),
    ...(ruleIssues.length
      ? [
          prisma.issue.createMany({
            data: ruleIssues.map((i) => ({ ...i, reportId: id, source: "RULE" as const })),
          }),
        ]
      : []),
  ]);

  // Flip status + emit "starting" with steps so the UI shows the checklist
  // immediately.
  await prisma.report.update({
    where: { id },
    data: {
      status: "REVIEWING",
      reviewStartedAt: startedAt,
      reviewProgress: { stage: "starting", startedAt: startedAt.toISOString(), steps } as any,
    },
  });
  publish(id, { stage: "starting", startedAt: startedAt.toISOString(), steps });

  // Run the actual agent review after the response is sent.
  after(async () => {
    try {
      await reviewReport(id);
    } catch (e: any) {
      console.error("reviewReport failed:", e?.message || e);
    }
  });

  return NextResponse.json({ status: "REVIEWING", startedAt: startedAt.toISOString(), steps }, { status: 202 });
}
