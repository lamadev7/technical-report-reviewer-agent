import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateMarkingScheme } from "@/lib/agent/markingScheme";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tpl = await prisma.kbTemplate.findUnique({ where: { id }, select: { markingScheme: true } });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ markingScheme: tpl.markingScheme });
}

// POST = force regenerate. Body optional: { wordCountMin?, wordCountMax? }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const tpl = await prisma.kbTemplate.findUnique({ where: { id }, select: { plainText: true } });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const scheme = generateMarkingScheme({
    plainText: tpl.plainText,
    wordCountMin: typeof body.wordCountMin === "number" ? body.wordCountMin : undefined,
    wordCountMax: typeof body.wordCountMax === "number" ? body.wordCountMax : undefined,
  });
  await prisma.kbTemplate.update({ where: { id }, data: { markingScheme: scheme as any } });
  return NextResponse.json({ markingScheme: scheme });
}
