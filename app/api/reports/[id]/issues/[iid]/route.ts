import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeMarking } from "@/lib/agent/marking";
import { recordRejections } from "@/lib/agent/learning";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; iid: string }> }) {
  const { id, iid } = await params;
  const body = await req.json();
  const patch: any = {};
  for (const k of ["severity", "category", "shortDescription"] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  const issue = await prisma.issue.update({ where: { id: iid }, data: patch });
  // Severity flips shift the deterministic mark; recompute on those edits.
  const marking = "severity" in patch ? await recomputeMarking(id) : null;
  return NextResponse.json({ ...issue, marking });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; iid: string }> }) {
  const { id, iid } = await params;
  const issue = await prisma.issue.findUnique({
    where: { id: iid },
    select: { shortDescription: true, quotedText: true, category: true, source: true, deleted: true },
  });
  await prisma.issue.update({ where: { id: iid }, data: { deleted: true } });
  // Record dismissal only for non-REVIEWER findings (it's not useful to learn
  // from the human deleting their own annotation), and only when this is the
  // first deletion of this row.
  if (issue && !issue.deleted && issue.source !== "REVIEWER") {
    await recordRejections([{
      shortDescription: issue.shortDescription,
      quotedText: issue.quotedText,
      category: issue.category,
    }]);
  }
  const marking = await recomputeMarking(id);
  return NextResponse.json({ ok: true, marking });
}
