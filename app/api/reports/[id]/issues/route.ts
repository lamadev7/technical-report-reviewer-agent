import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeMarking } from "@/lib/agent/marking";
import { recordRejections } from "@/lib/agent/learning";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const issues = await prisma.issue.findMany({
    where: { reportId: id, deleted: false },
    orderBy: { startOffset: "asc" },
  });
  return NextResponse.json({ issues });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const issue = await prisma.issue.create({
    data: {
      reportId: id,
      startOffset: body.startOffset,
      endOffset: body.endOffset,
      quotedText: body.quotedText || "",
      severity: body.severity || "MAJOR",
      category: body.category || "OTHER",
      shortDescription: body.shortDescription || "",
      source: "REVIEWER",
    },
  });
  const marking = await recomputeMarking(id);
  return NextResponse.json({ ...issue, marking });
}

// Bulk soft-delete by ids. Body: { ids: string[] }.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });
  // Snapshot the still-active ones first so we only learn from a fresh deletion
  // and so we don't double-record on a re-delete.
  const toRecord = await prisma.issue.findMany({
    where: { id: { in: ids }, reportId: id, deleted: false, source: { not: "REVIEWER" } },
    select: { shortDescription: true, quotedText: true, category: true },
  });
  const { count } = await prisma.issue.updateMany({
    where: { id: { in: ids }, reportId: id },
    data: { deleted: true },
  });
  if (toRecord.length) await recordRejections(toRecord);
  const marking = count > 0 ? await recomputeMarking(id) : null;
  return NextResponse.json({ ok: true, count, marking });
}
