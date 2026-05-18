import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prisma.report.update({ where: { id }, data: { status: "APPROVED" } });
  return NextResponse.json({ id: r.id, status: r.status });
}
