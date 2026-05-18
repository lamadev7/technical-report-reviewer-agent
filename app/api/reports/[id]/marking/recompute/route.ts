import { NextRequest, NextResponse } from "next/server";
import { recomputeMarking } from "@/lib/agent/marking";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const marking = await recomputeMarking(id);
  if (!marking) {
    return NextResponse.json(
      { error: "No baseline marking — run a full Review first." },
      { status: 400 },
    );
  }
  return NextResponse.json({ marking });
}
