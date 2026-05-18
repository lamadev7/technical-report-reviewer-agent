import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { save, remove } from "@/lib/storage";
import { ingestBuffer } from "@/lib/ingest/toHtml";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const { html, plainText } = await ingestBuffer(buf, file.name);
  const relPath = await save("templates", file.name, buf);
  const tpl = await prisma.kbTemplate.create({
    data: { name: file.name, filePath: relPath, htmlContent: html, plainText },
    select: { id: true, name: true, createdAt: true },
  });
  return NextResponse.json(tpl);
}

export async function GET() {
  const items = await prisma.kbTemplate.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true },
  });
  return NextResponse.json({ items });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  const tpl = await prisma.kbTemplate.findUnique({ where: { id } });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await remove(tpl.filePath);
  await prisma.kbTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
