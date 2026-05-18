"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import FileDrop from "./FileDrop";

type Mode = "STRICT" | "MODERATE" | "ACCEPTABLE";

export default function UploadReport() {
  const router = useRouter();
  const [reviewMode, setReviewMode] = useState<Mode>("MODERATE");
  const [markingMode, setMarkingMode] = useState<Mode>("MODERATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="text-zinc-700">Review mode</span>
          <select className="mt-1 block w-full rounded border-zinc-300" value={reviewMode} onChange={(e) => setReviewMode(e.target.value as Mode)}>
            <option value="STRICT">Strict</option>
            <option value="MODERATE">Moderate</option>
            <option value="ACCEPTABLE">Acceptable</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-zinc-700">Marking mode</span>
          <select className="mt-1 block w-full rounded border-zinc-300" value={markingMode} onChange={(e) => setMarkingMode(e.target.value as Mode)}>
            <option value="STRICT">Strict</option>
            <option value="MODERATE">Moderate</option>
            <option value="ACCEPTABLE">Acceptable</option>
          </select>
        </label>
      </div>
      <FileDrop
        disabled={busy}
        accept=".pdf,.doc,.docx"
        label={busy ? "Uploading…" : "Drag & drop or click to choose a report (.pdf, .doc, .docx)"}
        onFiles={async (files) => {
          setError(null);
          setBusy(true);
          try {
            const fd = new FormData();
            fd.append("file", files[0]);
            fd.append("reviewMode", reviewMode);
            fd.append("markingMode", markingMode);
            const res = await fetch("/api/reports", { method: "POST", body: fd });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
            const { id } = await res.json();
            router.push(`/report/${id}`);
          } catch (e: any) {
            setError(e.message || "Upload failed");
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <div className="text-sm text-red-600">{error}</div>}
    </div>
  );
}
