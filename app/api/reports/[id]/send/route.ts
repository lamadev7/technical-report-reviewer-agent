import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendReportFeedback } from "@/lib/email/send";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prisma.report.findUnique({ where: { id } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (r.status !== "APPROVED") return NextResponse.json({ error: "Report must be approved first" }, { status: 400 });
  try {
    const result = await sendReportFeedback(id);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Send failed" }, { status: 500 });
  }
}
