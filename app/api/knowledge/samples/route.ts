import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { save, remove } from "@/lib/storage";
import { ingestBuffer } from "@/lib/ingest/toHtml";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const quality = (form.get("quality") as string) || "EXCELLENT";
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (quality !== "EXCELLENT" && quality !== "BAD") {
    return NextResponse.json({ error: "quality must be EXCELLENT or BAD" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const { html, plainText } = await ingestBuffer(buf, file.name);
  const relPath = await save("samples", file.name, buf);
  const sample = await prisma.kbSample.create({
    data: { name: file.name, quality: quality as any, filePath: relPath, htmlContent: html, plainText },
    select: { id: true, name: true, quality: true, createdAt: true },
  });
  return NextResponse.json(sample);
}

export async function GET() {
  const items = await prisma.kbSample.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, quality: true, createdAt: true },
  });
  return NextResponse.json({ items });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  const s = await prisma.kbSample.findUnique({ where: { id } });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await remove(s.filePath);
  await prisma.kbSample.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
