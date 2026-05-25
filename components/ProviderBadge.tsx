"use client";

import { useEffect, useState, useRef } from "react";

type ProviderName = "anthropic" | "codex" | "gemini";

interface Availability {
  available: boolean;
  via: "sdk" | "cli" | "none";
  reason?: string;
}

interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

interface Status {
  current: ProviderName;
  source: "runtime" | "env" | "default";
  models: Record<ProviderName, string>;
  catalog: Record<ProviderName, ModelOption[]>;
  availability: Record<ProviderName, Availability>;
}

const META: Record<ProviderName, { label: string; color: string; dot: string }> = {
  anthropic: {
    label: "Anthropic Claude",
    color: "bg-amber-50 text-amber-800 ring-amber-200",
    dot: "bg-amber-500",
  },
  codex: {
    label: "OpenAI Codex",
    color: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
  },
  gemini: {
    label: "Google Gemini",
    color: "bg-sky-50 text-sky-700 ring-sky-200",
    dot: "bg-sky-500",
  },
};

export default function ProviderBadge() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ProviderName | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "error" | "ok"; msg: string } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
      setExpanded(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setExpanded(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  async function load() {
    try {
      const r = await fetch("/api/llm", { cache: "no-store" });
      const j = await r.json();
      setStatus(j);
    } catch (e: any) {
      setToast({ kind: "error", msg: `Failed to load LLM status: ${e?.message || e}` });
    }
  }

  async function applySwitch(payload: { provider: ProviderName; model?: string }) {
    setBusy(true);
    try {
      const r = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) {
        setToast({ kind: "error", msg: j?.error || `Switch failed (${r.status})` });
        return false;
      }
      setStatus(j);
      return true;
    } catch (e: any) {
      setToast({ kind: "error", msg: e?.message || "Switch failed" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pickProvider(p: ProviderName) {
    if (!status) return;
    const a = status.availability[p];
    if (!a.available) {
      setToast({ kind: "error", msg: a.reason || `${META[p].label} not available` });
      return;
    }
    if (p === status.current) {
      setExpanded((cur) => (cur === p ? null : p));
      return;
    }
    const ok = await applySwitch({ provider: p });
    if (ok) {
      setToast({ kind: "ok", msg: `Switched to ${META[p].label}` });
      setExpanded(p);
    }
  }

  async function pickModel(p: ProviderName, m: string) {
    if (!status) return;
    const a = status.availability[p];
    if (!a.available) {
      setToast({ kind: "error", msg: a.reason || `${META[p].label} not available` });
      return;
    }
    if (status.models[p] === m && status.current === p) return;
    const ok = await applySwitch({ provider: p, model: m });
    if (ok) {
      const label = status.catalog[p].find((x) => x.id === m)?.label || m;
      setToast({ kind: "ok", msg: `${META[p].label}: ${label}` });
    }
  }

  if (!status) {
    return (
      <div className="rounded-md px-2.5 py-2 text-[11px] ring-1 ring-zinc-200 bg-zinc-50 text-zinc-500">
        Loading…
      </div>
    );
  }

  const cur = status.current;
  const curMeta = META[cur];
  const curAvail = status.availability[cur];

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className={`w-full rounded-md px-2.5 py-2 text-left text-[11px] ring-1 transition ${curMeta.color} hover:brightness-95`}
        title={`Click to switch provider/model. Source: ${status.source}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide">
            <span className={`h-1.5 w-1.5 rounded-full ${curMeta.dot}`} />
            {curMeta.label}
          </span>
          <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-black/5">
            {curAvail.via}
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] opacity-80 truncate">
          {status.models[cur]}
        </div>
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-[70vh] overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg"
        >
          {(Object.keys(META) as ProviderName[]).map((p) => {
            const meta = META[p];
            const a = status.availability[p];
            const selected = p === cur;
            const disabled = !a.available;
            const isExpanded = expanded === p;
            return (
              <div key={p} className="border-b border-zinc-100 last:border-b-0">
                <button
                  onClick={() => pickProvider(p)}
                  disabled={busy || disabled}
                  className={`w-full px-3 py-2 text-left text-xs transition ${
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : selected
                        ? "bg-zinc-50"
                        : "hover:bg-zinc-50"
                  }`}
                  title={a.reason || (a.available ? `via ${a.via}` : "unavailable")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-semibold">
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                      {selected && (
                        <span className="ml-1 rounded bg-zinc-200 px-1 text-[9px] font-medium text-zinc-700">
                          ACTIVE
                        </span>
                      )}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-medium ring-1 ring-inset ${
                        a.available
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                          : "bg-rose-50 text-rose-700 ring-rose-200"
                      }`}
                    >
                      {a.available ? a.via : "unavailable"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-zinc-500 truncate">
                      {status.models[p]}
                    </span>
                    {!disabled && (
                      <span className="text-[10px] text-zinc-400">
                        {isExpanded ? "▴ hide models" : "▾ change model"}
                      </span>
                    )}
                  </div>
                  {disabled && a.reason && (
                    <div className="mt-1 text-[10px] text-rose-600">{a.reason}</div>
                  )}
                </button>

                {isExpanded && !disabled && (
                  <div className="bg-zinc-50/60 px-2 pb-2">
                    {status.catalog[p].map((opt) => {
                      const isCurrent = status.models[p] === opt.id;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => pickModel(p, opt.id)}
                          disabled={busy}
                          className={`w-full rounded px-2 py-1.5 text-left text-[11px] transition ${
                            isCurrent
                              ? "bg-white ring-1 ring-zinc-300"
                              : "hover:bg-white"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{opt.label}</span>
                            {isCurrent && (
                              <span className="rounded bg-zinc-200 px-1 text-[9px] font-medium text-zinc-700">
                                SELECTED
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[9.5px] text-zinc-500 truncate">
                              {opt.id}
                            </span>
                            {opt.note && (
                              <span className="text-[9.5px] text-zinc-500 italic shrink-0">
                                {opt.note}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md rounded-md px-3 py-2 text-xs shadow-lg ring-1 ${
            toast.kind === "error"
              ? "bg-rose-50 text-rose-800 ring-rose-200"
              : "bg-emerald-50 text-emerald-800 ring-emerald-200"
          }`}
          role="status"
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
