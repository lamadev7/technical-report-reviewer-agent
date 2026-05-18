import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeMarking } from "@/lib/agent/marking";

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
