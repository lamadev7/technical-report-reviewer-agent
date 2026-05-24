import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { save } from "@/lib/storage";
import { ingestBuffer } from "@/lib/ingest/toHtml";
import { extractHeader } from "@/lib/ingest/extractHeader";

export const runtime = "nodejs";

const ALLOWED = new Set([".pdf"]);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const reviewMode = (form.get("reviewMode") as string) || "MODERATE";
  const markingMode = (form.get("markingMode") as string) || "MODERATE";
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED.has(ext)) return NextResponse.json({ error: `Unsupported type: ${ext}` }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  let ingested;
  try {
    ingested = await ingestBuffer(buf, file.name);
  } catch (e: any) {
    return NextResponse.json({ error: `Ingest failed: ${e.message}` }, { status: 500 });
  }
  const relPath = await save("reports", file.name, buf);
  const header = extractHeader(ingested.plainText);

  // Default-select the most-recently-uploaded template so a new report has a
  // valid scheme target out of the box. The reviewer can still switch later.
  const defaultTemplate = await prisma.kbTemplate.findFirst({
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  const report = await prisma.report.create({
    data: {
      filename: file.name,
      originalPath: relPath,
      htmlContent: ingested.html,
      plainText: ingested.plainText,
      offsetMap: {},
      studentName: header.studentName,
      studentEmail: header.studentEmail,
      reviewMode: reviewMode as any,
      markingMode: markingMode as any,
      templateId: defaultTemplate?.id ?? null,
    },
    select: { id: true },
  });

  // Rule pass deferred until /review so the issue list stays empty until the
  // reviewer explicitly kicks off a review.

  return NextResponse.json({ id: report.id });
}

export async function GET() {
  const reports = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, filename: true, studentName: true, status: true, createdAt: true },
  });
  return NextResponse.json({ reports });
}
