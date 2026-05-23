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
  // Cumulative passive-voice-deletion penalty applied at Review time. Tracks
  // which dismissed passive-voice issue IDs have already been penalized so the
  // next review run only deducts for newly-dismissed ones.
  passiveDeletionPenalty?: number;
  passivePenaltyAppliedIds?: string[];
};

// Points deducted per deleted passive-voice issue at Review time.
export const W_PASSIVE_DELETE = 2;

// Apply the passive-voice-deletion penalty: count dismissed passive-voice
// issues that have not yet been penalized, deduct from marking.overall, and
// record their IDs so the next Review run doesn't double-count. Called once
// per full Review run, after Claude produces its marking baseline.
export async function applyPassiveDeletionPenalty(
  reportId: string,
  marking: Marking | null,
): Promise<Marking | null> {
  if (!marking) return marking;
  const dismissed = await prisma.issue.findMany({
    where: {
      reportId,
      deleted: true,
      shortDescription: { contains: "passive voice", mode: "insensitive" },
    },
    select: { id: true },
  });
  const already = new Set<string>(marking.passivePenaltyAppliedIds ?? []);
  const fresh = dismissed.filter((i) => !already.has(i.id));
  if (!fresh.length) return marking;
  const penalty = fresh.length * W_PASSIVE_DELETE;
  const overall = Math.max(0, Math.min(100, (marking.overall ?? 0) - penalty));
  return {
    ...marking,
    overall,
    passiveDeletionPenalty: (marking.passiveDeletionPenalty ?? 0) + penalty,
    passivePenaltyAppliedIds: [...already, ...fresh.map((i) => i.id)],
  };
}

// Default per-category penalty weights when no template scheme is attached.
// Grammar/passive-voice are very light (≈ -0.5 per 2 mistakes → 0.25 each).
// Format + word-count breaks are heavy (-5). Under-explained sections cost 1;
// over-explained 0.5; everything else 0.5 as a sensible default.
const DEFAULT_PENALTIES = {
  grammar: 0.25,
  format: 5,
  completeness: 5,
  sectionUnder: 1,
  sectionOver: 0.5,
  other: 0.5,
};

type IssueRow = { category: string; shortDescription: string };

function weightFor(issue: IssueRow, p: typeof DEFAULT_PENALTIES): number {
  switch (issue.category) {
    case "GRAMMAR":
      return p.grammar;
    case "FORMAT":
      return p.format;
    case "COMPLETENESS":
      return p.completeness;
    case "SECTION_QUALITY": {
      const d = issue.shortDescription.toLowerCase();
      if (d.startsWith("[over]") || d.includes("over-explain") || d.includes("overexplain")) {
        return p.sectionOver;
      }
      if (d.startsWith("[under]") || d.includes("under-explain") || d.includes("underexplain")) {
        return p.sectionUnder;
      }
      return p.sectionUnder; // SECTION_QUALITY default = under
    }
    default:
      return p.other;
  }
}

function totalPenalty(issues: IssueRow[], p: typeof DEFAULT_PENALTIES): number {
  return issues.reduce((acc, i) => acc + weightFor(i, p), 0);
}

async function penaltiesForReport(reportId: string): Promise<typeof DEFAULT_PENALTIES> {
  const r = await prisma.report.findUnique({
    where: { id: reportId },
    select: { template: { select: { markingScheme: true } } },
  });
  const p = (r?.template?.markingScheme as any)?.penalties;
  if (!p) return DEFAULT_PENALTIES;
  return { ...DEFAULT_PENALTIES, ...p };
}

// Recompute `overall` from the current open issues, anchored to whatever the
// LLM produced during the last full review. perSection scores are kept as-is.
//
// Returns the new marking object, or null when there's no baseline to anchor
// against (i.e. the report has never been reviewed by Claude).
export async function recomputeMarking(reportId: string): Promise<Marking | null> {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    select: { marking: true },
  });
  if (!report?.marking) return null;
  const marking = report.marking as Marking & { baselinePenalty?: number };

  const issues = await prisma.issue.findMany({
    where: { reportId, deleted: false },
    select: { category: true, shortDescription: true },
  });
  const penalties = await penaltiesForReport(reportId);
  const currentPenalty = totalPenalty(issues, penalties);

  // Snapshot the penalty Claude effectively saw on the first run so edits move
  // the score relative to that baseline rather than absolute counts.
  const baselineOverall = marking.baselineOverall ?? marking.overall;
  const baselinePenalty = marking.baselinePenalty ?? currentPenalty;

  const delta = currentPenalty - baselinePenalty;
  const overall = Math.max(0, Math.min(100, Math.round(baselineOverall - delta)));

  const next: Marking & { baselinePenalty?: number } = {
    ...marking,
    overall,
    baselineOverall,
    baselinePenalty,
  };

  await prisma.report.update({
    where: { id: reportId },
    data: { marking: next as any },
  });
  return next;
}
