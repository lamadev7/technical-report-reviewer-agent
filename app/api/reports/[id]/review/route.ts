import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { reviewReport } from "@/lib/agent/reviewer";
import { publish } from "@/lib/agent/reviewBus";

export const runtime = "nodejs";
export const maxDuration = 600;

function countWords(s: string): number {
  return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const report = await prisma.report.findUnique({
    where: { id },
    select: { status: true, plainText: true, wordCountLimit: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (report.status === "REVIEWING") {
    return NextResponse.json({ status: "REVIEWING", already: true }, { status: 202 });
  }

  // STEP 0 — word-count gate. Run before any Claude work so a too-short
  // report fails fast and doesn't burn tokens / CLI time.
  const words = countWords(report.plainText);
  const limit = report.wordCountLimit;
  if (limit > 0 && words < limit) {
    const msg = `Report has ${words} words — below required minimum of ${limit}. Increase length or lower the threshold and retry.`;
    // Don't clobber a previously-completed REVIEWED status — just record the
    // failed-attempt progress so SSE listeners and reloads see why.
    await prisma.report.update({
      where: { id },
      data: { reviewProgress: { stage: "failed", error: msg } as any },
    });
    publish(id, { stage: "failed", error: msg });
    return NextResponse.json({ error: msg, words, limit }, { status: 400 });
  }

  // Flip status + emit "starting" before returning so any client that opens
  // the SSE stream a tick later immediately sees the in-flight state.
  const startedAt = new Date();
  await prisma.report.update({
    where: { id },
    data: {
      status: "REVIEWING",
      reviewStartedAt: startedAt,
      reviewProgress: { stage: "starting", startedAt: startedAt.toISOString() } as any,
    },
  });
  publish(id, { stage: "starting", startedAt: startedAt.toISOString() });

  // Run the actual review after the response is sent. `after()` keeps the
  // server invocation alive long enough for the work to complete; on Node
  // self-hosting (the deployment target here) this runs to completion.
  after(async () => {
    try {
      await reviewReport(id);
    } catch (e: any) {
      console.error("reviewReport failed:", e?.message || e);
    }
  });

  return NextResponse.json({ status: "REVIEWING", startedAt: startedAt.toISOString() }, { status: 202 });
}
