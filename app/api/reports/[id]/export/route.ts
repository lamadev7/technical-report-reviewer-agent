import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { exportReviewPdf } from "@/lib/pdf/exportReview";
import { countMajorWords } from "@/lib/checks/majorContent";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.report.findUnique({
    where: { id },
    include: { issues: { where: { deleted: false }, orderBy: [{ severity: "asc" }, { startOffset: "asc" }] } },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const wordCount = countMajorWords(report.plainText);

  const pdf = await exportReviewPdf({
    filename: report.filename,
    studentName: report.studentName,
    studentEmail: report.studentEmail,
    status: report.status,
    reviewMode: report.reviewMode,
    markingMode: report.markingMode,
    marking: (report.marking as any) ?? null,
    wordCount,
    wordCountMin: report.wordCountMin,
    wordCountMax: report.wordCountMax,
    issues: report.issues.map((i) => ({
      startOffset: i.startOffset,
      endOffset: i.endOffset,
      quotedText: i.quotedText,
      severity: i.severity,
      category: i.category,
      shortDescription: i.shortDescription,
      source: i.source,
    })),
    generatedAt: new Date(),
  });

  const base = report.filename.replace(/\.(pdf|docx?|md)$/i, "");
  const outName = `${base}-review.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(outName)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
