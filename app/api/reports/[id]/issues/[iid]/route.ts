import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeMarking } from "@/lib/agent/marking";

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
  await prisma.issue.update({ where: { id: iid }, data: { deleted: true } });
  const marking = await recomputeMarking(id);
  return NextResponse.json({ ok: true, marking });
}
