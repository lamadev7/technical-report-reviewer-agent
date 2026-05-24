import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { subscribe, isTerminal, type ReviewProgress } from "@/lib/agent/reviewBus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-Sent Events stream for review progress. Clients subscribe on mount
// when a report is in REVIEWING state — first event is the latest snapshot
// loaded from the DB so a refresh / new tab immediately catches up; subsequent
// events come live from the in-process reviewBus.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Prime the stream so the browser flushes response headers and starts
      // dispatching `message` events immediately rather than buffering until
      // a chunk threshold is hit.
      try {
        controller.enqueue(encoder.encode(`retry: 5000\n: open\n\n`));
      } catch {}

      // Initial snapshot from DB so a fresh client lands in the right state.
      const r = await prisma.report.findUnique({
        where: { id },
        select: { status: true, reviewProgress: true, reviewStartedAt: true, marking: true },
      });
      if (!r) {
        send({ stage: "failed", error: "Report not found" });
        controller.close();
        return;
      }
      const stored = r.reviewProgress as ReviewProgress | null;
      const statusTerminal =
        r.status === "REVIEWED" || r.status === "APPROVED" || r.status === "SENT";
      // If the stored progress is a terminal stage (failed/cancelled/reviewed)
      // from a prior run but the report's current status is NOT terminal
      // (UPLOADED/REVIEWING), treat it as stale. Otherwise a fresh client that
      // just clicked Review races the POST-side DB update and gets served the
      // old terminal snapshot — which makes its SSE handler immediately flip
      // `reviewing` back to false and hide the progress bar.
      let snapshot: ReviewProgress;
      if (statusTerminal) {
        snapshot = stored ?? { stage: "reviewed" };
      } else if (stored && !isTerminal(stored.stage)) {
        snapshot = stored;
      } else {
        snapshot = { stage: "starting" };
      }
      send(snapshot);

      if (statusTerminal) {
        controller.close();
        return;
      }

      const unsubscribe = subscribe(id, (evt) => {
        send(evt);
        if (isTerminal(evt.stage)) {
          try { controller.close(); } catch {}
          closed = true;
        }
      });

      // Heartbeat keeps proxies / browsers from idling the connection out.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        closed = true;
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
