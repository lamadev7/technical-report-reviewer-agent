import Link from "next/link";
import { prisma } from "@/lib/db";
import SidebarHistory from "./SidebarHistory";
import ProviderBadge from "./ProviderBadge";

export default async function Sidebar() {
  let reports: Array<{ id: string; studentName: string | null; filename: string; status: string }> = [];
  try {
    reports = await prisma.report.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, studentName: true, filename: true, status: true },
    });
  } catch {
    // DB may not be migrated yet — render empty list
  }

  const items = reports.map((r) => ({
    id: r.id,
    label: r.studentName || r.filename,
    status: r.status,
  }));

  return (
    <aside className="w-64 border-r border-zinc-200 bg-white p-4 flex flex-col gap-2 h-full">
      <Link href="/" className="font-semibold text-lg mb-4">Report Reviewer</Link>
      <nav className="flex flex-col gap-1 text-sm">
        <Link href="/" className="rounded px-2 py-1.5 hover:bg-zinc-100">Home — Upload</Link>
        <Link href="/knowledge" className="rounded px-2 py-1.5 hover:bg-zinc-100">Knowledge Base</Link>
      </nav>
      <div className="mt-6 text-xs uppercase tracking-wide text-zinc-500">History</div>
      <ul className="flex flex-col gap-0.5 overflow-y-auto text-sm flex-1">
        <SidebarHistory initial={items} />
      </ul>
      <div className="mt-2 pt-2 border-t border-zinc-200">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Active LLM</div>
        <ProviderBadge />
      </div>
    </aside>
  );
}
