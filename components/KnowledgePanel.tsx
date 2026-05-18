"use client";
import { useState } from "react";
import FileDrop from "./FileDrop";
import KnowledgePreviewModal from "./KnowledgePreviewModal";

type Tpl = { id: string; name: string; createdAt: string | Date; previewHtml?: string };
type Sample = { id: string; name: string; quality: "EXCELLENT" | "BAD"; createdAt: string | Date; previewHtml?: string };

type PreviewTarget = { kind: "template" | "sample"; id: string; name: string };

export default function KnowledgePanel({ initialTemplates, initialSamples }: { initialTemplates: Tpl[]; initialSamples: Sample[] }) {
  const [tab, setTab] = useState<"templates" | "samples">("templates");
  const [templates, setTemplates] = useState<Tpl[]>(initialTemplates);
  const [samples, setSamples] = useState<Sample[]>(initialSamples);
  const [sampleQuality, setSampleQuality] = useState<"EXCELLENT" | "BAD">("EXCELLENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  return (
    <div>
      <div className="flex gap-2 mb-4 border-b border-zinc-200">
        <button onClick={() => setTab("templates")} className={`px-3 py-2 text-sm ${tab === "templates" ? "border-b-2 border-zinc-900 font-medium" : "text-zinc-500"}`}>
          Templates
        </button>
        <button onClick={() => setTab("samples")} className={`px-3 py-2 text-sm ${tab === "samples" ? "border-b-2 border-zinc-900 font-medium" : "text-zinc-500"}`}>
          Report Samples
        </button>
      </div>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}

      {tab === "templates" && (
        <>
          <FileDrop
            disabled={busy}
            label={busy ? "Uploading…" : "Drop template (.pdf/.docx/.doc)"}
            onFiles={async (files) => {
              setBusy(true); setError(null);
              try {
                const fd = new FormData();
                fd.append("file", files[0]);
                const res = await fetch("/api/knowledge/templates", { method: "POST", body: fd });
                if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
                const tpl = await res.json();
                setTemplates((t) => [tpl, ...t]);
              } catch (e: any) { setError(e.message); }
              finally { setBusy(false); }
            }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            {templates.length === 0 && <div className="col-span-full text-zinc-400 text-sm italic">No templates yet.</div>}
            {templates.map((t) => (
              <PreviewCard
                key={t.id}
                title={t.name}
                previewHtml={t.previewHtml}
                onOpen={() => setPreview({ kind: "template", id: t.id, name: t.name })}
                onDelete={async () => {
                  if (!confirm(`Delete "${t.name}"?`)) return;
                  await fetch("/api/knowledge/templates", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: t.id }) });
                  setTemplates((tt) => tt.filter((x) => x.id !== t.id));
                }}
              />
            ))}
          </div>
        </>
      )}

      {tab === "samples" && (
        <>
          <div className="mb-3">
            <label className="text-sm mr-2">Quality:</label>
            <select className="rounded border-zinc-300 text-sm" value={sampleQuality} onChange={(e) => setSampleQuality(e.target.value as any)}>
              <option value="EXCELLENT">Excellent</option>
              <option value="BAD">Bad</option>
            </select>
          </div>
          <FileDrop
            disabled={busy}
            label={busy ? "Uploading…" : `Drop ${sampleQuality.toLowerCase()} sample (.pdf/.docx/.doc)`}
            onFiles={async (files) => {
              setBusy(true); setError(null);
              try {
                const fd = new FormData();
                fd.append("file", files[0]);
                fd.append("quality", sampleQuality);
                const res = await fetch("/api/knowledge/samples", { method: "POST", body: fd });
                if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
                const s = await res.json();
                setSamples((ss) => [s, ...ss]);
              } catch (e: any) { setError(e.message); }
              finally { setBusy(false); }
            }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            {samples.length === 0 && <div className="col-span-full text-zinc-400 text-sm italic">No samples yet.</div>}
            {samples.map((s) => (
              <PreviewCard
                key={s.id}
                title={s.name}
                previewHtml={s.previewHtml}
                badge={s.quality}
                onOpen={() => setPreview({ kind: "sample", id: s.id, name: s.name })}
                onDelete={async () => {
                  if (!confirm(`Delete "${s.name}"?`)) return;
                  await fetch("/api/knowledge/samples", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id }) });
                  setSamples((ss) => ss.filter((x) => x.id !== s.id));
                }}
              />
            ))}
          </div>
        </>
      )}

      {preview && (
        <KnowledgePreviewModal
          kind={preview.kind}
          id={preview.id}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function PreviewCard({ title, previewHtml, badge, onOpen, onDelete }: { title: string; previewHtml?: string; badge?: "EXCELLENT" | "BAD"; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="border border-zinc-200 rounded bg-white overflow-hidden flex flex-col">
      <button
        onClick={onOpen}
        className="relative h-44 overflow-hidden bg-zinc-50 text-left p-3 border-b border-zinc-200 cursor-zoom-in group"
        title="Click to preview"
      >
        {previewHtml ? (
          <div
            className="text-[10px] leading-snug text-zinc-700 [&_*]:!m-0 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium"
            // KB content originates from operator-uploaded files via mammoth/pdf2json — trusted source.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <div className="text-xs text-zinc-400 italic">No preview</div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" />
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-900 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
          <EyeIcon /> View
        </div>
      </button>
      <div className="p-3 flex items-center gap-2">
        {badge && (
          <span className={`px-1.5 py-0.5 text-[10px] rounded ${badge === "EXCELLENT" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>{badge}</span>
        )}
        <div className="text-sm truncate flex-1" title={title}>{title}</div>
        <button onClick={onOpen} className="text-zinc-500 hover:text-zinc-900" title="Preview">
          <EyeIcon />
        </button>
        <button onClick={onDelete} className="text-xs text-red-600 hover:underline">Delete</button>
      </div>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
