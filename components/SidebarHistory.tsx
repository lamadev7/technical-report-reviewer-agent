"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

type Item = { id: string; label: string; status: string };

export default function SidebarHistory({ initial }: { initial: Item[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<Item[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (items.length === 0) {
    return <li className="text-zinc-400 italic px-2 py-1">No reports yet</li>;
  }

  return (
    <>
      {items.map((r) => {
        const href = `/report/${r.id}`;
        const isActive = pathname === href;
        const isReviewing = r.status === "REVIEWING";
        const isSent = r.status === "SENT";
        const isApproved = r.status === "APPROVED";
        const showCheck = isSent || isApproved;
        return (
          <li key={r.id} className="group relative">
            <Link
              href={href}
              className={`flex items-center gap-1.5 rounded px-2 py-1.5 hover:bg-zinc-100 ${isActive ? "bg-zinc-100" : ""}`}
            >
              {isReviewing && (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"
                  title="Reviewing…"
                />
              )}
              {showCheck && (
                <svg
                  viewBox="0 0 16 16"
                  className={`w-3.5 h-3.5 shrink-0 ${isSent ? "text-emerald-600" : "text-sky-600"}`}
                  aria-label={isSent ? "Feedback emailed" : "Approved"}
                >
                  <title>{isSent ? "Feedback emailed to student" : "Approved (not yet sent)"}</title>
                  <path
                    fill="currentColor"
                    d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.78 5.97a.75.75 0 0 0-1.06 0L7 9.69 5.28 7.97a.75.75 0 1 0-1.06 1.06l2.25 2.25c.3.3.77.3 1.06 0l4.25-4.25a.75.75 0 0 0 0-1.06Z"
                  />
                </svg>
              )}
              <span className="truncate flex-1">{r.label}</span>
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (busyId) return;
                  if (!confirm(`Delete "${r.label}"? This removes the report and all its issues.`)) return;
                  setBusyId(r.id);
                  try {
                    const res = await fetch(`/api/reports/${r.id}`, { method: "DELETE" });
                    if (!res.ok) throw new Error("Delete failed");
                    setItems((xs) => xs.filter((x) => x.id !== r.id));
                    if (isActive) router.push("/");
                    else router.refresh();
                  } catch (err) {
                    alert((err as Error).message);
                  } finally {
                    setBusyId(null);
                  }
                }}
                disabled={busyId === r.id}
                title="Delete report"
                className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-600 text-xs shrink-0 disabled:opacity-50"
              >
                {busyId === r.id ? "…" : "✕"}
              </button>
            </Link>
          </li>
        );
      })}
    </>
  );
}
