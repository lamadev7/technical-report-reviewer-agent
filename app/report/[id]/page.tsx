import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import ReportViewer from "@/components/ReportViewer";
import { SKILLS, defaultSkillIds } from "@/lib/agent/skills";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.report.findUnique({
    where: { id },
    include: { issues: { where: { deleted: false }, orderBy: { startOffset: "asc" } } },
  });
  if (!report) notFound();

  const templates = await prisma.kbTemplate.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });

  return (
    <ReportViewer
      report={{
        id: report.id,
        filename: report.filename,
        htmlContent: report.htmlContent,
        plainText: report.plainText,
        studentName: report.studentName,
        studentEmail: report.studentEmail,
        reviewMode: report.reviewMode,
        markingMode: report.markingMode,
        status: report.status,
        templateId: report.templateId,
        enabledSkills: report.enabledSkills?.length ? report.enabledSkills : defaultSkillIds(),
        marking: (report.marking as any) || null,
        reviewStartedAt: report.reviewStartedAt ? report.reviewStartedAt.toISOString() : null,
        reviewProgress: (report.reviewProgress as any) || null,
        wordCountLimit: report.wordCountLimit,
      }}
      skillCatalog={SKILLS.map((s) => ({ id: s.id, name: s.name, blurb: s.blurb }))}
      issues={report.issues.map((i) => ({
        id: i.id,
        startOffset: i.startOffset,
        endOffset: i.endOffset,
        quotedText: i.quotedText,
        severity: i.severity,
        category: i.category,
        shortDescription: i.shortDescription,
        source: i.source,
      }))}
      templates={templates}
    />
  );
}
