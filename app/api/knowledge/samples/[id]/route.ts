import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await prisma.kbSample.findUnique({
    where: { id },
    select: { id: true, name: true, quality: true, htmlContent: true, createdAt: true },
  });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(s);
}
