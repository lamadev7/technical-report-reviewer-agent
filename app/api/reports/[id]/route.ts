import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { remove } from "@/lib/storage";
import { ensureTemplateMarkingScheme } from "@/lib/agent/markingScheme";
import { recomputeMarking } from "@/lib/agent/marking";

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
  if ("studentEmail" in body) {
    const e = typeof body.studentEmail === "string" ? body.studentEmail.trim() : "";
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    patch.studentEmail = e || null;
  }
  if (typeof body.wordCountMin === "number" && body.wordCountMin >= 0) {
    patch.wordCountMin = Math.floor(body.wordCountMin);
  }
  if (typeof body.wordCountMax === "number" && body.wordCountMax >= 0) {
    patch.wordCountMax = Math.floor(body.wordCountMax);
  }
  const updated = await prisma.report.update({ where: { id }, data: patch });
  // When the template selection changes, make sure that template has a
  // persisted marking scheme and recompute the report's marking against it.
  if ("templateId" in patch && updated.templateId) {
    try {
      await ensureTemplateMarkingScheme(updated.templateId);
      await recomputeMarking(id);
    } catch (e: any) {
      console.warn("template scheme / recompute failed:", e?.message || e);
    }
  }
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
