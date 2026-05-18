import { prisma } from "@/lib/db";

export type Marking = {
  overall: number;
  perSection?: Array<{ title: string; score: number; note?: string }>;
  // Snapshot of the LLM's overall at the time the review ran. Lets the
  // recompute step adjust the live overall relative to that baseline without
  // throwing away Claude's qualitative judgement.
  baselineOverall?: number;
  baselineCritical?: number;
  baselineMajor?: number;
};

// Penalty weights for the deterministic recompute. Tuned so that adding /
// removing a single MAJOR moves the score by a couple of points and a
// CRITICAL by ~5 — noticeable but not catastrophic.
const W_CRITICAL = 5;
const W_MAJOR = 2;

// Recompute `overall` from the current open issues, anchored to whatever the
// LLM produced during the last full review. perSection scores are kept as-is
// (they need section attribution that we don't recompute deterministically).
//
// Returns the new marking object, or null when there's no baseline to anchor
// against (i.e. the report has never been reviewed by Claude).
export async function recomputeMarking(reportId: string): Promise<Marking | null> {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    select: { marking: true },
  });
  if (!report?.marking) return null;
  const marking = report.marking as Marking;

  const issues = await prisma.issue.findMany({
    where: { reportId, deleted: false },
    select: { severity: true },
  });
  const critical = issues.filter((i) => i.severity === "CRITICAL").length;
  const major = issues.filter((i) => i.severity === "MAJOR").length;

  // Establish a baseline on first recompute so subsequent edits move the
  // overall relative to the issue set Claude saw, not absolute counts.
  const baselineOverall = marking.baselineOverall ?? marking.overall;
  const baselineCritical = marking.baselineCritical ?? critical;
  const baselineMajor = marking.baselineMajor ?? major;

  const dCritical = critical - baselineCritical;
  const dMajor = major - baselineMajor;
  const delta = dCritical * W_CRITICAL + dMajor * W_MAJOR;
  const overall = Math.max(0, Math.min(100, Math.round(baselineOverall - delta)));

  const next: Marking = {
    ...marking,
    overall,
    baselineOverall,
    baselineCritical,
    baselineMajor,
  };

  await prisma.report.update({
    where: { id: reportId },
    data: { marking: next as any },
  });
  return next;
}
