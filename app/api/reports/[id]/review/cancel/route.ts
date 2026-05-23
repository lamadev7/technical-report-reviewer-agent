import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { triggerAbort, publish } from "@/lib/agent/reviewBus";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const aborted = triggerAbort(id);
  // Even if no controller was registered (e.g. server restart lost the map),
  // flip status so the UI exits the reviewing state.
  await prisma.report.update({
    where: { id },
    data: {
      status: "UPLOADED",
      reviewProgress: { stage: "cancelled", message: "Review cancelled by user" } as any,
    },
  }).catch(() => {});
  publish(id, { stage: "cancelled", message: "Review cancelled by user" });
  return NextResponse.json({ ok: true, aborted });
}
