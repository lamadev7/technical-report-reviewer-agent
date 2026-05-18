import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { remove } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.report.findUnique({
    where: { id },
    include: { issues: { where: { deleted: false }, orderBy: { startOffset: "asc" } } },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(report);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const patch: any = {};
  if (body.reviewMode) patch.reviewMode = body.reviewMode;
  if (body.markingMode) patch.markingMode = body.markingMode;
  if (body.status) patch.status = body.status;
  if ("templateId" in body) patch.templateId = body.templateId || null;
  if (Array.isArray(body.enabledSkills)) patch.enabledSkills = body.enabledSkills;
  if (typeof body.wordCountLimit === "number" && body.wordCountLimit >= 0) {
    patch.wordCountLimit = Math.floor(body.wordCountLimit);
  }
  const updated = await prisma.report.update({ where: { id }, data: patch });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await prisma.report.findUnique({ where: { id }, select: { originalPath: true } });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await remove(report.originalPath);
  await prisma.report.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
