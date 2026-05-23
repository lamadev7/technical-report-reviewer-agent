import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const W = { GRAMMAR: 0.25, FORMAT: 5, COMPLETENESS: 5, SECTION_QUALITY_UNDER: 1, SECTION_QUALITY_OVER: 0.5, SECTION_QUALITY_DEFAULT: 1, OTHER: 0.5 };
const reports = await p.report.findMany({ where: { marking: { equals: null } }, select: { id: true } });
for (const r of reports) {
  const issues = await p.issue.findMany({ where: { reportId: r.id, deleted: false }, select: { category: true, shortDescription: true } });
  const penalty = issues.reduce((acc, i) => {
    const d = i.shortDescription.toLowerCase();
    switch (i.category) {
      case "GRAMMAR": return acc + W.GRAMMAR;
      case "FORMAT": return acc + W.FORMAT;
      case "COMPLETENESS": return acc + W.COMPLETENESS;
      case "SECTION_QUALITY":
        if (d.startsWith("[over]")) return acc + W.SECTION_QUALITY_OVER;
        if (d.startsWith("[under]")) return acc + W.SECTION_QUALITY_UNDER;
        return acc + W.SECTION_QUALITY_DEFAULT;
      default: return acc + W.OTHER;
    }
  }, 0);
  const overall = Math.max(0, Math.min(100, Math.round(85 - penalty)));
  const marking = { overall, perSection: [], baselineOverall: overall, baselinePenalty: penalty, fallback: true };
  await p.report.update({ where: { id: r.id }, data: { marking } });
  console.log(r.id, "→", overall, "(penalty", penalty, "from", issues.length, "issues)");
}
await p.$disconnect();
