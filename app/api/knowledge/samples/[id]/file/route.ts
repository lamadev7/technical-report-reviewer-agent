import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { prisma } from "@/lib/db";
import { load } from "@/lib/storage";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await prisma.kbSample.findUnique({ where: { id }, select: { filePath: true, name: true } });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const buf = await load(s.filePath);
  const ext = path.extname(s.name).toLowerCase();
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(s.name)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
