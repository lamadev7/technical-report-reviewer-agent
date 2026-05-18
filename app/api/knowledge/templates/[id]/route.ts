import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tpl = await prisma.kbTemplate.findUnique({
    where: { id },
    select: { id: true, name: true, htmlContent: true, createdAt: true },
  });
  if (!tpl) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(tpl);
}
