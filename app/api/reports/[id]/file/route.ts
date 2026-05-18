import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { load } from "@/lib/storage";
import path from "node:path";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await prisma.report.findUnique({ where: { id }, select: { originalPath: true, filename: true } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const buf = await load(r.originalPath);
  const ext = path.extname(r.filename).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${encodeURIComponent(r.filename)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
