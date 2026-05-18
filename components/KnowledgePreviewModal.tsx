"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const PdfReportViewer = dynamic(() => import("./PdfReportViewer"), { ssr: false, loading: () => <div className="p-8 text-zinc-500 text-sm">Loading PDF viewer…</div> });

export default function KnowledgePreviewModal({ kind, id, name, onClose }: { kind: "template" | "sample"; id: string; name: string; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isPdf = name.toLowerCase().endsWith(".pdf");
  const base = kind === "template" ? "/api/knowledge/templates" : "/api/knowledge/samples";

  useEffect(() => {
    if (isPdf) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${base}/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => { if (!cancelled) { setHtml(j.htmlContent); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [base, id, isPdf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-3 border-b border-zinc-200">
          <span className="text-xs uppercase tracking-wide text-zinc-500">{kind}</span>
          <div className="text-sm font-semibold truncate flex-1" title={name}>{name}</div>
          <a
            href={`${base}/${id}/file`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Open file
          </a>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-900 text-xl leading-none">×</button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-6 bg-zinc-50">
          {loading && <div className="text-zinc-500 text-sm">Loading…</div>}
          {error && <div className="text-red-600 text-sm">Failed: {error}</div>}
          {!loading && !error && isPdf && (
            <PdfReportViewer fileUrl={`${base}/${id}/file`} issues={[]} />
          )}
          {!loading && !error && !isPdf && html && (
            <div
              className="prose prose-zinc max-w-3xl mx-auto bg-white p-8 rounded shadow-sm"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
