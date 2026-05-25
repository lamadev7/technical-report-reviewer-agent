"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { countMajorWords } from "@/lib/checks/majorContent";
import { explainPresence } from "@/lib/agent/sectionGroups";

const PdfReportViewer = dynamic(() => import("./PdfReportViewer"), { ssr: false, loading: () => <div className="p-8 text-zinc-500 text-sm">Loading PDF viewer…</div> });

type Severity = "CRITICAL" | "MAJOR";
type Category = "GRAMMAR" | "FORMAT" | "COMPLETENESS" | "SECTION_QUALITY" | "OTHER";

export type Issue = {
  id: string;
  startOffset: number;
  endOffset: number;
  quotedText: string;
  severity: Severity;
  category: Category;
  shortDescription: string;
  source: "AGENT" | "REVIEWER" | "RULE";
};

type ReviewProgress = {
  stage: "starting" | "rules-done" | "agent-running" | "agent-done" | "marking-running" | "reviewed" | "failed" | "cancelled";
  steps?: Array<{ name: string; status: "pending" | "pass" | "fail"; detail?: string }>;
  ruleCount?: number;
  agentCount?: number;
  startedAt?: string;
  message?: string;
  error?: string;
};

type Report = {
  id: string;
  filename: string;
  htmlContent: string;
  plainText: string;
  studentName: string | null;
  studentEmail: string | null;
  reviewMode: "STRICT" | "MODERATE" | "ACCEPTABLE";
  markingMode: "STRICT" | "MODERATE" | "ACCEPTABLE";
  status: "UPLOADED" | "REVIEWING" | "REVIEWED" | "APPROVED" | "SENT";
  templateId: string | null;
  marking: { overall: number; perSection: Array<{ title: string; score: number; note?: string }> } | null;
  reviewStartedAt: string | null;
  reviewProgress: ReviewProgress | null;
  wordCountMin: number;
  wordCountMax: number;
};

type TemplateOpt = { id: string; name: string };

export default function ReportViewer({ report, issues: initialIssues, templates }: { report: Report; issues: Issue[]; templates: TemplateOpt[] }) {
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [marking, setMarking] = useState(report.marking);
  // Sync state with fresh server props after router.refresh() so the marking
  // card actually picks up newly-computed scores instead of staying stuck on
  // the value read at mount time.
  useEffect(() => { setIssues(initialIssues); }, [initialIssues]);
  useEffect(() => { setMarking(report.marking); }, [report.marking]);
  const [recomputingMark, setRecomputingMark] = useState(false);
  const initialReviewing = report.status === "REVIEWING";
  const initialStart = report.reviewStartedAt ? new Date(report.reviewStartedAt).getTime() : null;
  const [reviewing, setReviewing] = useState(initialReviewing);
  const [reviewStart, setReviewStart] = useState<number | null>(initialStart);
  const [elapsed, setElapsed] = useState(initialStart ? Math.max(0, Math.floor((Date.now() - initialStart) / 1000)) : 0);
  const [progress, setProgress] = useState<ReviewProgress | null>(report.reviewProgress);
  const [error, setError] = useState<string | null>(report.reviewProgress?.error ?? null);

  // Tick elapsed seconds while reviewing.
  useEffect(() => {
    if (!reviewing || reviewStart == null) return;
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - reviewStart) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [reviewing, reviewStart]);

  // SSE subscription drives progress + final state. Survives page refresh and
  // tab switches because the server-side reviewer keeps running independently
  // and the DB has the latest snapshot. If SSE drops (server restart, dev HMR),
  // a status-polling fallback below catches the terminal transition.
  useEffect(() => {
    if (!reviewing) return;
    const es = new EventSource(`/api/reports/${report.id}/review/stream`);
    es.onmessage = (ev) => {
      try {
        const data: ReviewProgress = JSON.parse(ev.data);
        setProgress(data);
        if (data.error) setError(data.error);
        if (data.stage === "reviewed") {
          setReviewing(false);
          setReviewStart(null);
          es.close();
          router.refresh();
        } else if (data.stage === "failed") {
          setReviewing(false);
          setReviewStart(null);
          setError(data.error || "Review failed");
          es.close();
        } else if (data.stage === "cancelled") {
          setReviewing(false);
          setReviewStart(null);
          es.close();
          router.refresh();
        }
      } catch {}
    };
    // EventSource auto-reconnects on transient errors; only force-close on
    // unmount via the cleanup below.
    return () => es.close();
  }, [reviewing, report.id, router]);

  // Status fallback: poll /api/reports/[id] every 5s while reviewing. Catches
  // the terminal transition even if the SSE stream was severed (e.g. dev HMR
  // killed the route handler mid-review).
  useEffect(() => {
    if (!reviewing) return;
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/reports/${report.id}`);
        if (!r.ok) return;
        const data = await r.json();
        if (data.reviewProgress) setProgress(data.reviewProgress);
        if (data.status === "REVIEWED" || data.status === "APPROVED" || data.status === "SENT") {
          setReviewing(false);
          setReviewStart(null);
          router.refresh();
        } else if (data.reviewProgress?.stage === "failed") {
          setReviewing(false);
          setReviewStart(null);
          setError(data.reviewProgress.error || "Review failed");
        } else if (data.reviewProgress?.stage === "cancelled") {
          setReviewing(false);
          setReviewStart(null);
          router.refresh();
        }
      } catch {}
    }, 5000);
    return () => clearInterval(poll);
  }, [reviewing, report.id, router]);

  // Poll issues every 4s while reviewing so newly-saved findings appear before
  // the final SSE event arrives.
  useEffect(() => {
    if (!reviewing) return;
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/reports/${report.id}/issues`);
        if (r.ok) {
          const { issues: latest } = await r.json();
          setIssues(latest);
        }
      } catch {}
    }, 4000);
    return () => clearInterval(poll);
  }, [reviewing, report.id]);
  const [hovered, setHovered] = useState<{ issue: Issue; rect: { x: number; y: number } } | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchHits, setSearchHits] = useState(0);
  const [searchActive, setSearchActive] = useState(0);
  const [reviewMode, setReviewMode] = useState(report.reviewMode);
  const [wordCountMin, setWordCountMin] = useState<number>(report.wordCountMin ?? 8000);
  const [wordCountMax, setWordCountMax] = useState<number>(report.wordCountMax ?? 12000);
  const [severityFilter, setSeverityFilter] = useState<"ALL" | "CRITICAL" | "MAJOR">("ALL");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(360);
  const [markingCollapsed, setMarkingCollapsed] = useState(false);
  const [preflightCollapsed, setPreflightCollapsed] = useState(false);
  const [adding, setAdding] = useState<null | { quotedText: string; startOffset: number; endOffset: number }>(null);
  const [schemeOpen, setSchemeOpen] = useState(false);
  const [scheme, setScheme] = useState<any | null>(null);
  const [schemeLoading, setSchemeLoading] = useState(false);
  const [schemeError, setSchemeError] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = Number(window.localStorage.getItem("rr.right.width"));
    if (w >= 240 && w <= 800) setRightWidth(w);
    setRightCollapsed(window.localStorage.getItem("rr.right.collapsed") === "1");
    setMarkingCollapsed(window.localStorage.getItem("rr.marking.collapsed") === "1");
    setPreflightCollapsed(window.localStorage.getItem("rr.preflight.collapsed") === "1");
  }, []);
  const persistRightWidth = (w: number) => {
    try { window.localStorage.setItem("rr.right.width", String(w)); } catch {}
  };
  const persistRightCollapsed = (v: boolean) => {
    try { window.localStorage.setItem("rr.right.collapsed", v ? "1" : "0"); } catch {}
  };
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: rightWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // The aside is on the RIGHT — dragging the handle leftwards widens it.
      const delta = dragRef.current.startX - ev.clientX;
      const next = Math.max(240, Math.min(800, dragRef.current.startW + delta));
      setRightWidth(next);
    };
    const onUp = () => {
      if (dragRef.current) persistRightWidth(rightWidthRef.current);
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const rightWidthRef = useRef(rightWidth);
  useEffect(() => { rightWidthRef.current = rightWidth; }, [rightWidth]);
  const wordCount = useMemo(() => countMajorWords(report.plainText), [report.plainText]);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const wordCountOutOfRange =
    (wordCountMin > 0 && wordCount < wordCountMin) || (wordCountMax > 0 && wordCount > wordCountMax);
  const filteredIssues = useMemo(
    () => (severityFilter === "ALL" ? issues : issues.filter((i) => i.severity === severityFilter)),
    [issues, severityFilter],
  );
  const visibleIds = useMemo(() => filteredIssues.map((i) => i.id), [filteredIssues]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const [templateId, setTemplateId] = useState<string | "">(report.templateId || "");
  const [studentEmail, setStudentEmail] = useState<string>(report.studentEmail ?? "");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail.trim());
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const isPdf = report.filename.toLowerCase().endsWith(".pdf");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(id);
  }, [search]);

  // Inject highlights after each render (HTML path only — PDF viewer wraps highlights itself)
  useEffect(() => {
    if (isPdf) return;
    const root = docRef.current;
    if (!root) return;
    // Reset by replacing innerHTML with original (strip our spans)
    root.innerHTML = report.htmlContent;
    enhanceHeadingsAndToc(root);
    // When a specific issue is selected, only highlight that one — the rest
    // visually disappear so the reviewer can focus. Empty selection ⇒ show
    // all marks as before.
    const visibleIssues = activeIssueId ? issues.filter((i) => i.id === activeIssueId) : issues;
    if (visibleIssues.length) applyHighlights(root, visibleIssues);
    const count = applySearchHighlights(root, debouncedSearch);
    setSearchHits(count);
    setSearchActive((prev) => (count === 0 ? 0 : Math.min(prev, count - 1)));
    const onOver = (e: Event) => {
      const t = e.target as HTMLElement;
      const span = t.closest?.("mark.hl[data-issue-id]") as HTMLElement | null;
      if (!span) return;
      const id = span.dataset.issueId;
      const iss = issues.find((x) => x.id === id);
      if (!iss) return;
      const r = span.getBoundingClientRect();
      setHovered({ issue: iss, rect: { x: r.left + r.width / 2, y: r.top } });
    };
    const onOut = (e: Event) => {
      const t = e.target as HTMLElement;
      const span = t.closest?.("mark.hl[data-issue-id]") as HTMLElement | null;
      if (!span) return;
      setHovered(null);
    };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
    };
  }, [issues, report.htmlContent, isPdf, debouncedSearch, activeIssueId]);

  // Document-level TOC click handler. Anchors are recreated on every htmlContent
  // reset so we delegate from the document and intercept .rr-toc-link clicks.
  useEffect(() => {
    if (isPdf) return;
    document.addEventListener("click", onTocLinkClick);
    return () => document.removeEventListener("click", onTocLinkClick);
  }, [isPdf]);

  // Esc clears the focus filter so all highlights come back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeIssueId) setActiveIssueId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIssueId]);

  // Clicking a highlighted span anywhere in the doc/PDF selects + scrolls to
  // the matching card so the reviewer can see the full description for the
  // span they tapped.
  useEffect(() => {
    const onMarkClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const mark = t.closest?.("mark[data-issue-id]") as HTMLElement | null;
      if (!mark) return;
      const id = mark.dataset.issueId;
      if (!id) return;
      setActiveIssueId(id);
      const card = cardRefs.current.get(id);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    document.addEventListener("click", onMarkClick);
    return () => document.removeEventListener("click", onMarkClick);
  }, []);

  // Move "active" class to current search hit and scroll into view. Works for
  // both HTML (docRef-scoped marks) and PDF (text-layer marks rendered by
  // PdfReportViewer with the same class names).
  useEffect(() => {
    const all = document.querySelectorAll<HTMLElement>("mark.search-hit");
    all.forEach((el) => el.classList.remove("search-hit-active"));
    if (!all.length || !debouncedSearch) return;
    const idx = Math.max(0, Math.min(searchActive, all.length - 1));
    const target = all[idx];
    if (!target) return;
    target.classList.add("search-hit-active");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [debouncedSearch, searchActive, issues, report.htmlContent]);

  const templateCount = templates.length;
  const canReview = templateCount > 0 && !reviewing;

  const scrollToIssue = (issueId: string) => {
    const issue = issues.find((i) => i.id === issueId);
    setActiveIssueId(issueId);
    const card = cardRefs.current.get(issueId);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const flash = (el: Element) => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("hl-flash");
      setTimeout(() => el.classList.remove("hl-flash"), 1200);
    };

    // 1. Best case: a mark already exists in the DOM with this issue id.
    const direct = document.querySelector(`mark[data-issue-id="${issueId}"]`);
    if (direct) return flash(direct);

    if (!issue) return;

    // 2. PDF text layer: walk every text span and find a substring match. Some
    //    issues (esp. RULE pass) carry quotedText that the customTextRenderer
    //    didn't wrap because the quote spans multiple text items.
    if (isPdf) {
      const needle = issue.quotedText?.replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase();
      if (needle) {
        const spans = document.querySelectorAll<HTMLElement>(".react-pdf__Page__textContent span");
        for (const s of spans) {
          if (s.textContent && s.textContent.replace(/\s+/g, " ").toLowerCase().includes(needle)) {
            return flash(s);
          }
        }
      }
      return;
    }

    // 3. HTML mode: locate the quotedText anywhere in the document and scroll
    //    to that node even if no mark wraps it.
    const root = docRef.current;
    if (!root) return;
    const quoted = issue.quotedText?.trim();
    if (quoted) {
      const target = findTextNodeContaining(root, quoted);
      if (target?.parentElement) return flash(target.parentElement);
    }

    // 4. Final fallback: use startOffset to land near the right paragraph.
    const node = nodeAtCharOffset(root, issue.startOffset ?? 0);
    if (node?.parentElement) flash(node.parentElement);
  };

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-zinc-200 bg-white p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-sm font-semibold truncate">{report.studentName || report.filename}</div>
          {report.studentName && (
            <div className="text-xs text-zinc-500 truncate min-w-0">{report.filename}</div>
          )}
          <span className={`inline-flex items-center shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusBadgeClass(report.status)}`}>
            {report.status}
          </span>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
        <label className="flex-1 min-w-[200px] max-w-md flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
          Search
          <div className="flex items-center gap-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search in report…"
              className="flex-1 rounded border border-zinc-300 px-2 py-1 text-sm normal-case tracking-normal text-zinc-900"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!searchHits) return;
                  setSearchActive((i) => (e.shiftKey ? (i - 1 + searchHits) % searchHits : (i + 1) % searchHits));
                }
                if (e.key === "Escape") setSearch("");
              }}
            />
            {debouncedSearch && (
              <>
                <span className="text-xs text-zinc-500 tabular-nums w-[70px] text-center normal-case tracking-normal">
                  {searchHits === 0 ? "0 hits" : `${searchActive + 1} / ${searchHits}`}
                </span>
                <button
                  disabled={!searchHits}
                  onClick={() => setSearchActive((i) => (i - 1 + searchHits) % searchHits)}
                  className="rounded border border-zinc-300 px-1.5 py-1 text-sm disabled:opacity-40 normal-case tracking-normal"
                  title="Previous (Shift+Enter)"
                >↑</button>
                <button
                  disabled={!searchHits}
                  onClick={() => setSearchActive((i) => (i + 1) % searchHits)}
                  className="rounded border border-zinc-300 px-1.5 py-1 text-sm disabled:opacity-40 normal-case tracking-normal"
                  title="Next (Enter)"
                >↓</button>
              </>
            )}
          </div>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500" title="Pin a template — review will compare against this one only">
          Template
          <select
            className="rounded border border-zinc-300 px-2 py-1 text-sm max-w-[200px] normal-case tracking-normal text-zinc-900"
            value={templateId}
            onChange={async (e) => {
              const v = e.target.value;
              setTemplateId(v);
              await fetch(`/api/reports/${report.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: v || null }) });
            }}
          >
            <option value="">All templates</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
          Mode
          <select
            className="rounded border border-zinc-300 px-2 py-1 text-sm normal-case tracking-normal text-zinc-900"
            value={reviewMode}
            onChange={async (e) => {
              const m = e.target.value as Report["reviewMode"];
              setReviewMode(m);
              await fetch(`/api/reports/${report.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewMode: m }) });
            }}
          >
            <option value="STRICT">Strict</option>
            <option value="MODERATE">Moderate</option>
            <option value="ACCEPTABLE">Acceptable</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500" title="Minimum required word count — review aborts if shorter. 0 disables.">
          Min words
          <input
            type="number"
            min={0}
            step={500}
            value={wordCountMin}
            onChange={(e) => setWordCountMin(Number(e.target.value))}
            onBlur={async () => {
              await fetch(`/api/reports/${report.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ wordCountMin }),
              });
            }}
            className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm tabular-nums normal-case tracking-normal text-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500" title="Maximum allowed word count — review aborts if longer. 0 disables.">
          Max words
          <input
            type="number"
            min={0}
            step={500}
            value={wordCountMax}
            onChange={(e) => setWordCountMax(Number(e.target.value))}
            onBlur={async () => {
              await fetch(`/api/reports/${report.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ wordCountMax }),
              });
            }}
            className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm tabular-nums normal-case tracking-normal text-zinc-900"
          />
        </label>
        <div
          className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500"
          title={wordCountOutOfRange ? "Outside configured range" : "Major-content word count (Intro → before Conclusion, bullets excluded)"}
        >
          <span className="flex items-center gap-1">
            Words
            <button
              onClick={async () => {
                if (recheckBusy) return;
                setRecheckBusy(true);
                try {
                  const res = await fetch(`/api/reports/${report.id}/checks/recheck`, { method: "POST" });
                  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || "Recheck failed");
                  const body = await res.json();
                  if (Array.isArray(body.issues)) setIssues(body.issues);
                  if (body.marking) setMarking(body.marking);
                  router.refresh();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setRecheckBusy(false);
                }
              }}
              title="Re-run word-count + structure checks against current min/max"
              disabled={recheckBusy}
              className="text-zinc-500 hover:text-zinc-800 disabled:opacity-40"
              aria-label="Refresh word-count checks"
            >
              <svg viewBox="0 0 16 16" width="11" height="11" className={recheckBusy ? "animate-spin" : ""} aria-hidden="true">
                <path fill="currentColor" d="M8 3V1L4 4l4 3V5a3 3 0 1 1-3 3H3a5 5 0 1 0 5-5Z"/>
              </svg>
            </button>
          </span>
          <span
            className={`inline-block w-20 rounded border px-2 py-1 text-sm tabular-nums text-center normal-case tracking-normal ${
              wordCountOutOfRange ? "border-red-400 bg-red-50 text-red-700" : "border-zinc-300 text-zinc-900"
            }`}
          >
            {wordCount.toLocaleString()}
          </span>
        </div>
        <label
          className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500"
          title={report.studentEmail ? "Student email from report — edit if needed" : "Add a student email to enable sending feedback"}
        >
          <span className="flex items-center gap-1">
            Email
            {emailSaving && <span className="text-[10px] normal-case tracking-normal text-zinc-400">saving…</span>}
            {emailError && <span className="text-[10px] normal-case tracking-normal text-red-600">{emailError}</span>}
          </span>
          <input
            type="email"
            value={studentEmail}
            placeholder="student@example.com"
            onChange={(e) => { setStudentEmail(e.target.value); if (emailError) setEmailError(null); }}
            onBlur={async () => {
              const trimmed = studentEmail.trim();
              if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
                setEmailError("Invalid email");
                return;
              }
              if (trimmed === (report.studentEmail ?? "")) return;
              setEmailSaving(true);
              try {
                const res = await fetch(`/api/reports/${report.id}`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ studentEmail: trimmed }),
                });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({} as any));
                  setEmailError(body.error || "Save failed");
                } else {
                  router.refresh();
                }
              } finally {
                setEmailSaving(false);
              }
            }}
            className={`w-56 rounded border px-2 py-1 text-sm normal-case tracking-normal text-zinc-900 ${emailError ? "border-red-400" : "border-zinc-300"}`}
          />
        </label>
        <div className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
          <span aria-hidden="true">&nbsp;</span>
          <div className="flex items-center gap-1">
          <button
          disabled={!canReview}
          onClick={async () => {
            const now = Date.now();
            // Persist any pending word-count edit before kicking off review.
            await fetch(`/api/reports/${report.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ wordCountMin, wordCountMax }),
            }).catch(() => {});
            setReviewing(true); setReviewStart(now); setElapsed(0); setError(null);
            setProgress({ stage: "starting", startedAt: new Date(now).toISOString() });
            try {
              const res = await fetch(`/api/reports/${report.id}/review`, { method: "POST" });
              if (!res.ok && res.status !== 202) {
                const ct = res.headers.get("content-type") || "";
                let msg = `Review failed to start (HTTP ${res.status})`;
                if (ct.includes("application/json")) {
                  const body = await res.json().catch(() => ({} as any));
                  if (body?.error) msg = body.error;
                } else {
                  const text = await res.text().catch(() => "");
                  if (text) msg = `Server error: ${text.slice(0, 200)}`;
                }
                throw new Error(msg);
              }
              // SSE drives the rest — leave reviewing=true until server emits a terminal stage.
            } catch (e: any) {
              setError(e.message);
              setReviewing(false);
              setReviewStart(null);
              setProgress({ stage: "failed", error: e.message });
            }
          }}
          className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50 normal-case tracking-normal"
          title={templateCount === 0 ? "Upload at least one template first" : ""}
        >
          {reviewing ? `Reviewing… ${elapsed}s` : "Review"}
        </button>
        {reviewing && (
          <button
            onClick={async () => {
              if (!confirm("Cancel the in-flight review? Progress will be saved.")) return;
              await fetch(`/api/reports/${report.id}/review/cancel`, { method: "POST" }).catch(() => {});
              setReviewing(false);
              setReviewStart(null);
              setProgress({ stage: "cancelled", message: "Review cancelled by user" });
            }}
            className="grid h-7 w-7 place-items-center rounded border border-red-300 bg-white text-red-600 hover:bg-red-50"
            title="Stop the in-flight review"
            aria-label="Stop review"
          >
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        )}
        </div>
        </div>
        </div>
      </header>

      {(reviewing || (progress?.steps && progress.steps.length > 0)) && (
        <ReviewProgress elapsed={elapsed} issues={issues} progress={progress} />
      )}
      {error && <div className="bg-red-50 text-red-700 text-sm p-2">{error}</div>}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 overflow-y-auto p-6 bg-zinc-100">
          {isPdf ? (
            <PdfReportViewer
              fileUrl={`/api/reports/${report.id}/file`}
              issues={issues}
              activeIssueId={activeIssueId}
              search={debouncedSearch}
              onMarkHover={(iss, rect) => setHovered(rect ? { issue: iss, rect } : null)}
              onSearchHitsChange={(n) => {
                setSearchHits(n);
                setSearchActive((prev) => (n === 0 ? 0 : Math.min(prev, n - 1)));
              }}
            />
          ) : (
            <div ref={docRef} className="prose prose-zinc max-w-3xl mx-auto bg-white p-8 rounded shadow-sm rr-doc-wrap" />
          )}
        </div>

        {!rightCollapsed && (
          <div
            onMouseDown={onDragStart}
            className="group relative w-px cursor-col-resize bg-zinc-200 hover:bg-blue-400"
            title="Drag to resize"
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        )}
        <button
          onClick={() => {
            setRightCollapsed((c) => {
              const next = !c;
              persistRightCollapsed(next);
              return next;
            });
          }}
          className="self-start mt-3 -ml-3 z-10 grid h-6 w-6 place-items-center rounded-full border border-zinc-200 bg-white text-xs text-zinc-600 shadow hover:bg-zinc-50"
          title={rightCollapsed ? "Show issues panel" : "Hide issues panel"}
        >
          {rightCollapsed ? "‹" : "›"}
        </button>
        <aside
          style={{ width: rightCollapsed ? 0 : rightWidth }}
          className={`${rightCollapsed ? "w-0 overflow-hidden" : ""} bg-white overflow-y-auto p-4 flex flex-col gap-3 shrink-0`}
        >
          {marking && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3">
              <div className={`flex items-center gap-2 ${markingCollapsed ? "" : "mb-1"}`}>
                <button
                  onClick={() => {
                    setMarkingCollapsed((c) => {
                      const next = !c;
                      try { window.localStorage.setItem("rr.marking.collapsed", next ? "1" : "0"); } catch {}
                      return next;
                    });
                  }}
                  className="text-amber-700 hover:text-amber-900"
                  aria-label={markingCollapsed ? "Expand marking" : "Collapse marking"}
                  title={markingCollapsed ? "Expand" : "Collapse"}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={`transition-transform ${markingCollapsed ? "-rotate-90" : ""}`}>
                    <path fill="currentColor" d="M3 5h10L8 11z"/>
                  </svg>
                </button>
                <div className="text-xs uppercase tracking-wide text-amber-700">Marking · reviewer-only</div>
                {!markingCollapsed && <>
                <button
                  onClick={async () => {
                    setSchemeOpen(true);
                    if (!report.templateId) {
                      setSchemeError("Select a template first to see its marking scheme.");
                      return;
                    }
                    if (scheme || schemeLoading) return;
                    setSchemeLoading(true);
                    setSchemeError(null);
                    try {
                      const res = await fetch(`/api/knowledge/templates/${report.templateId}/scheme`);
                      const json = await res.json();
                      if (!res.ok) throw new Error(json.error || "Failed to load scheme");
                      if (!json.markingScheme) {
                        // Trigger generation on demand.
                        const gen = await fetch(`/api/knowledge/templates/${report.templateId}/scheme`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
                        const genJson = await gen.json();
                        if (!gen.ok) throw new Error(genJson.error || "Failed to generate scheme");
                        setScheme(genJson.markingScheme);
                      } else {
                        setScheme(json.markingScheme);
                      }
                    } catch (e: any) {
                      setSchemeError(e.message);
                    } finally {
                      setSchemeLoading(false);
                    }
                  }}
                  title="View auto-generated marking scheme for this template"
                  className="text-amber-700 hover:text-amber-900"
                  aria-label="View marking scheme"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 11.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm-.75-8.25V8h1.5V4.75h-1.5Zm0 4.5V11h1.5v-1.5h-1.5Z"/>
                  </svg>
                </button>
                <button
                  onClick={async () => {
                    if (recomputingMark) return;
                    setRecomputingMark(true);
                    try {
                      const res = await fetch(`/api/reports/${report.id}/marking/recompute`, { method: "POST" });
                      if (!res.ok) {
                        const body = await res.json().catch(() => ({} as any));
                        throw new Error(body.error || "Recompute failed");
                      }
                      const { marking: m } = await res.json();
                      if (m) setMarking(m);
                    } catch (e: any) {
                      setError(e.message);
                    } finally {
                      setRecomputingMark(false);
                    }
                  }}
                  disabled={recomputingMark}
                  title="Recalculate marking from current issues"
                  className="ml-auto text-amber-700 hover:text-amber-900 disabled:opacity-40"
                >
                  <RefreshIcon spinning={recomputingMark} />
                </button>
                </>}
              </div>
              {!markingCollapsed && (
                <>
                  <div className="text-2xl font-semibold">{marking.overall}/100</div>
                  <ul className="mt-2 text-xs space-y-0.5">
                    {marking.perSection?.map((s, i) => (
                      <li key={i} className="flex justify-between"><span className="truncate">{s.title}</span><span className="font-mono">{s.score}</span></li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {progress?.steps && progress.steps.length > 0 && (
            <div className="rounded border border-blue-200 bg-blue-50 p-3">
              <div className={`flex items-center gap-2 ${preflightCollapsed ? "" : "mb-1.5"}`}>
                <button
                  onClick={() => {
                    setPreflightCollapsed((c) => {
                      const next = !c;
                      try { window.localStorage.setItem("rr.preflight.collapsed", next ? "1" : "0"); } catch {}
                      return next;
                    });
                  }}
                  className="text-blue-800 hover:text-blue-900"
                  aria-label={preflightCollapsed ? "Expand preflight" : "Collapse preflight"}
                  title={preflightCollapsed ? "Expand" : "Collapse"}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className={`transition-transform ${preflightCollapsed ? "-rotate-90" : ""}`}>
                    <path fill="currentColor" d="M3 5h10L8 11z"/>
                  </svg>
                </button>
                <div className="text-xs uppercase tracking-wide text-blue-800 font-medium">
                  Preflight checks
                </div>
              </div>
              {!preflightCollapsed && (
                <ul className="flex flex-col gap-1 text-xs">
                  {progress.steps.map((s, i) => {
                    const icon = s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "…";
                    const tone =
                      s.status === "pass" ? "text-emerald-700"
                      : s.status === "fail" ? "text-red-700"
                      : "text-zinc-500";
                    return (
                      <li key={i} className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-1.5">
                          <span className={`font-mono ${tone}`}>{icon}</span>
                          <span className="font-medium text-zinc-800">{s.name}</span>
                        </div>
                        {s.detail && (
                          <span className="text-[11px] text-zinc-600 pl-4 leading-snug">{s.detail}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold text-sm">
              Issues ({issues.length}{severityFilter !== "ALL" ? ` · ${filteredIssues.length} ${severityFilter.toLowerCase()}` : ""})
              {issues.length > 0 && (
                <span className="ml-2 text-xs font-normal text-zinc-500">
                  {issues.filter((i) => i.source === "RULE").length} rule ·{" "}
                  {issues.filter((i) => i.source === "AGENT").length} AI ·{" "}
                  {issues.filter((i) => i.source === "REVIEWER").length} you
                </span>
              )}
            </h2>
            <div className="flex items-center gap-1.5">
              {activeIssueId && (
                <button
                  onClick={() => setActiveIssueId(null)}
                  className="text-xs rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50"
                  title="Esc — clear selection, show all highlights"
                >
                  Show all
                </button>
              )}
              <button
              onClick={() => {
                const sel = window.getSelection();
                let quotedText = "";
                let offset = 0;
                if (sel && !sel.isCollapsed) {
                  quotedText = sel.toString().trim();
                  if (isPdf) {
                    const norm = quotedText.replace(/\s+/g, " ");
                    const idx = report.plainText.replace(/\s+/g, " ").indexOf(norm);
                    offset = idx >= 0 ? idx : 0;
                  } else {
                    const root = docRef.current;
                    const range = sel.getRangeAt(0);
                    offset = computeOffset(root, range.startContainer, range.startOffset);
                  }
                }
                setAdding({
                  quotedText,
                  startOffset: offset,
                  endOffset: offset + quotedText.length,
                });
              }}
              className="text-xs rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50"
              title="Add a new issue (select text in the report first to attach it to a span)"
            >+ Add</button>
            </div>
          </div>

          {adding && (
            <NewIssueCard
              draft={adding}
              onChangeDraft={setAdding}
              onCancel={() => setAdding(null)}
              onSave={async (payload) => {
                const res = await fetch(`/api/reports/${report.id}/issues`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(payload),
                });
                if (!res.ok) {
                  const b = await res.json().catch(() => ({} as any));
                  throw new Error(b.error || "Add failed");
                }
                const body = await res.json();
                const { marking: m, ...iss } = body;
                setIssues((xs) => [...xs, iss as Issue].sort((a, b) => a.startOffset - b.startOffset));
                if (m) setMarking(m);
                setAdding(null);
              }}
            />
          )}

          {issues.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5 text-[11px]">
              {(["ALL", "CRITICAL", "MAJOR"] as const).map((sev) => {
                const count = sev === "ALL" ? issues.length : issues.filter((i) => i.severity === sev).length;
                const active = severityFilter === sev;
                const tone =
                  sev === "CRITICAL" ? "bg-red-100 text-red-800 border-red-200"
                  : sev === "MAJOR" ? "bg-orange-100 text-orange-800 border-orange-200"
                  : "bg-zinc-100 text-zinc-700 border-zinc-200";
                return (
                  <button
                    key={sev}
                    onClick={() => setSeverityFilter(sev)}
                    className={`rounded-full border px-2 py-0.5 ${active ? "ring-2 ring-blue-400 " : ""}${tone}`}
                  >
                    {sev === "ALL" ? "All" : sev.charAt(0) + sev.slice(1).toLowerCase()} · {count}
                  </button>
                );
              })}
              <label className="ml-2 inline-flex items-center gap-1 text-zinc-600">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) visibleIds.forEach((id) => next.add(id));
                      else visibleIds.forEach((id) => next.delete(id));
                      return next;
                    });
                  }}
                />
                Select all visible
              </label>
              {selectedIds.size > 0 && (
                <button
                  disabled={bulkBusy}
                  onClick={async () => {
                    const ids = Array.from(selectedIds);
                    if (!confirm(`Delete ${ids.length} selected issue${ids.length === 1 ? "" : "s"}?`)) return;
                    setBulkBusy(true);
                    try {
                      const res = await fetch(`/api/reports/${report.id}/issues`, {
                        method: "DELETE",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ ids }),
                      });
                      if (res.ok) {
                        const json = await res.json().catch(() => ({} as any));
                        setIssues((xs) => xs.filter((x) => !selectedIds.has(x.id)));
                        setSelectedIds(new Set());
                        if (json.marking) setMarking(json.marking);
                      }
                    } finally {
                      setBulkBusy(false);
                    }
                  }}
                  className="ml-auto rounded bg-red-600 text-white px-2 py-0.5 disabled:opacity-50"
                >
                  {bulkBusy ? "Deleting…" : `Delete ${selectedIds.size}`}
                </button>
              )}
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {filteredIssues.length === 0 && (
              <li className="text-xs text-zinc-400 italic">
                {issues.length === 0 ? "No issues yet. Click Review." : `No ${severityFilter.toLowerCase()} issues.`}
              </li>
            )}
            {filteredIssues.map((iss) => (
              <IssueCard
                key={iss.id}
                issue={iss}
                isHovered={hovered?.issue.id === iss.id}
                isActive={activeIssueId === iss.id}
                selected={selectedIds.has(iss.id)}
                onToggleSelect={() =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(iss.id)) next.delete(iss.id);
                    else next.add(iss.id);
                    return next;
                  })
                }
                registerRef={(el) => {
                  if (el) cardRefs.current.set(iss.id, el);
                  else cardRefs.current.delete(iss.id);
                }}
                onScrollTo={() => scrollToIssue(iss.id)}
                onUpdate={async (patch) => {
                  const res = await fetch(`/api/reports/${report.id}/issues/${iss.id}`, {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(patch),
                  });
                  if (res.ok) {
                    const json = await res.json();
                    setIssues((xs) => xs.map((x) => (x.id === iss.id ? { ...x, ...patch } : x)));
                    if (json.marking) setMarking(json.marking);
                  }
                }}
                onDelete={async () => {
                  const res = await fetch(`/api/reports/${report.id}/issues/${iss.id}`, { method: "DELETE" });
                  setIssues((xs) => xs.filter((x) => x.id !== iss.id));
                  setSelectedIds((prev) => {
                    if (!prev.has(iss.id)) return prev;
                    const next = new Set(prev);
                    next.delete(iss.id);
                    return next;
                  });
                  if (res.ok) {
                    const json = await res.json().catch(() => ({} as any));
                    if (json.marking) setMarking(json.marking);
                  }
                }}
              />
            ))}
          </ul>

          <div className="mt-auto pt-3 border-t border-zinc-200 flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                disabled={approving || report.status === "APPROVED" || report.status === "SENT" || issues.length === 0}
                onClick={async () => {
                  setApproving(true);
                  try {
                    await fetch(`/api/reports/${report.id}/approve`, { method: "POST" });
                    router.refresh();
                  } finally { setApproving(false); }
                }}
                className="flex-1 rounded bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {report.status === "APPROVED" || report.status === "SENT" ? "Approved" : "Approve"}
              </button>
              <button
                disabled={exporting || issues.length === 0 || reviewing}
                onClick={async () => {
                  setExporting(true); setError(null);
                  try {
                    const res = await fetch(`/api/reports/${report.id}/export`);
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Export failed");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    const base = report.filename.replace(/\.(pdf|docx?|md)$/i, "");
                    a.download = `${base}-review.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                  } catch (e: any) { setError(e.message); }
                  finally { setExporting(false); }
                }}
                className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                title={reviewing ? "Wait for review to finish" : issues.length === 0 ? "No issues to export" : "Download review as PDF"}
              >
                {exporting ? "Exporting…" : "Export PDF"}
              </button>
              <button
                disabled={
                  sending ||
                  !emailValid ||
                  emailSaving ||
                  (report.status !== "APPROVED" && report.status !== "SENT")
                }
                onClick={async () => {
                  const trimmed = studentEmail.trim();
                  if (!trimmed || !emailValid) {
                    setEmailError("Enter a valid email first");
                    return;
                  }
                  setSending(true); setError(null);
                  try {
                    // Persist any unsaved email edit before sending so the server reads the latest value.
                    if (trimmed !== (report.studentEmail ?? "")) {
                      const patch = await fetch(`/api/reports/${report.id}`, {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ studentEmail: trimmed }),
                      });
                      if (!patch.ok) {
                        const body = await patch.json().catch(() => ({} as any));
                        throw new Error(body.error || "Could not save email");
                      }
                    }
                    const res = await fetch(`/api/reports/${report.id}/send`, { method: "POST" });
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Send failed");
                    router.refresh();
                  } catch (e: any) { setError(e.message); }
                  finally { setSending(false); }
                }}
                className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
                title={
                  report.status !== "APPROVED" && report.status !== "SENT"
                    ? "Approve first"
                    : !emailValid
                      ? "Add a valid email first"
                      : `Send to ${studentEmail.trim()}`
                }
              >
                {sending ? "Sending…" : report.status === "SENT" ? "Re-send Email" : "Send Email"}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {hovered && (
        <div
          className="fixed max-w-sm bg-zinc-900 text-white text-xs rounded p-2.5 shadow-lg z-50 pointer-events-none"
          style={{
            left: Math.max(8, Math.min(window.innerWidth - 320, hovered.rect.x - 160)),
            top: Math.max(8, hovered.rect.y - 8),
            transform: "translateY(-100%)",
          }}
        >
          <div className="font-semibold mb-1 flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${hovered.issue.severity === "CRITICAL" ? "bg-red-400" : "bg-orange-400"}`} />
            {hovered.issue.severity} · {hovered.issue.category}
            <span className="ml-auto text-[10px] opacity-60">{hovered.issue.source}</span>
          </div>
          <div>{hovered.issue.shortDescription}</div>
          <div
            className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-2 h-2 bg-zinc-900 rotate-45"
            style={{ left: Math.max(12, Math.min(312, hovered.rect.x - Math.max(8, Math.min(window.innerWidth - 320, hovered.rect.x - 160)))) }}
          />
        </div>
      )}
      {schemeOpen && (
        <SchemeModal
          scheme={scheme}
          loading={schemeLoading}
          error={schemeError}
          templateId={report.templateId}
          reportPlainText={report.plainText}
          onRegenerate={async () => {
            if (!report.templateId) return;
            setSchemeLoading(true);
            setSchemeError(null);
            try {
              const res = await fetch(`/api/knowledge/templates/${report.templateId}/scheme`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
              const json = await res.json();
              if (!res.ok) throw new Error(json.error || "Regenerate failed");
              setScheme(json.markingScheme);
            } catch (e: any) {
              setSchemeError(e.message);
            } finally {
              setSchemeLoading(false);
            }
          }}
          onClose={() => setSchemeOpen(false)}
        />
      )}
    </div>
  );
}

function SchemeModal({ scheme, loading, error, templateId, reportPlainText, onRegenerate, onClose }: {
  scheme: any | null;
  loading: boolean;
  error: string | null;
  templateId: string | null;
  reportPlainText: string;
  onRegenerate: () => void;
  onClose: () => void;
}) {
  // Synonym-aware presence check shared with the rule pass + LLM skill.
  // Returns `{present, reason}` so the row tooltip can explain WHY a section
  // is marked missing (which synonyms were searched, what counts as present).
  const presenceFor = (heading: string) => explainPresence(heading, reportPlainText);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h3 className="text-sm font-semibold">Marking scheme · auto-generated from template</h3>
          <div className="flex items-center gap-2">
            {templateId && (
              <button
                onClick={onRegenerate}
                disabled={loading}
                className="text-xs rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 disabled:opacity-50"
                title="Regenerate scheme from the latest template content"
              >
                {loading ? "…" : "Regenerate"}
              </button>
            )}
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-800 text-xl leading-none px-1" aria-label="Close">×</button>
          </div>
        </div>
        <div className="px-5 py-4 text-sm">
          {error && <div className="rounded bg-red-50 text-red-700 p-2 text-xs mb-3">{error}</div>}
          {!error && !scheme && loading && <div className="text-zinc-500 text-xs">Loading scheme…</div>}
          {!error && !scheme && !loading && <div className="text-zinc-500 text-xs">No scheme available.</div>}
          {scheme && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-zinc-200 p-2">
                  <div className="uppercase text-zinc-500 mb-1 text-[10px] tracking-wide">Total</div>
                  <div className="font-semibold text-lg">{scheme.totalPoints} pts</div>
                </div>
                <div className="rounded border border-zinc-200 p-2">
                  <div className="uppercase text-zinc-500 mb-1 text-[10px] tracking-wide">Word count band</div>
                  <div className="font-semibold">{scheme.wordCountBand.min.toLocaleString()} – {scheme.wordCountBand.max.toLocaleString()}</div>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Topic weights</div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-zinc-500 border-b border-zinc-200">
                      <th className="py-1 font-medium w-6">#</th>
                      <th className="py-1 font-medium w-8">In&nbsp;report</th>
                      <th className="py-1 font-medium">Topic</th>
                      <th className="py-1 font-medium text-right">Weight</th>
                      <th className="py-1 font-medium text-right">Required</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheme.topics.map((t: any, i: number) => {
                      const presence = presenceFor(t.heading);
                      const present = presence.present;
                      return (
                        <tr key={t.id} className="border-b border-zinc-100">
                          <td className="py-1 text-zinc-500">{i + 1}</td>
                          <td className="py-1 cursor-help" title={presence.reason}>
                            {present ? (
                              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-emerald-600" aria-label="present"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.78 5.97a.75.75 0 0 0-1.06 0L7 9.69 5.28 7.97a.75.75 0 1 0-1.06 1.06l2.25 2.25c.3.3.77.3 1.06 0l4.25-4.25a.75.75 0 0 0 0-1.06Z"/></svg>
                            ) : (
                              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-red-600" aria-label="missing"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm2.78 4.22a.75.75 0 0 0-1.06 0L8 5.94 6.28 4.22a.75.75 0 1 0-1.06 1.06L6.94 7 5.22 8.72a.75.75 0 1 0 1.06 1.06L8 8.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L9.06 7l1.72-1.72a.75.75 0 0 0 0-1.06Z"/></svg>
                            )}
                          </td>
                          <td className="py-1 cursor-help" title={presence.reason}>{t.heading}</td>
                          <td className="py-1 text-right tabular-nums">{t.weight} pts</td>
                          <td className="py-1 text-right text-zinc-500">{t.required ? "yes" : "no"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Bucket budgets</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {Object.entries(scheme.buckets).map(([k, v]) => (
                        <tr key={k} className="border-b border-zinc-100">
                          <td className="py-1 capitalize text-zinc-700">{k.replace(/([A-Z])/g, " $1").trim()}</td>
                          <td className="py-1 text-right tabular-nums">{String(v)} pts</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Per-issue penalties</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {Object.entries(scheme.penalties).map(([k, v]) => (
                        <tr key={k} className="border-b border-zinc-100">
                          <td className="py-1 capitalize text-zinc-700">{k.replace(/([A-Z])/g, " $1").trim()}</td>
                          <td className="py-1 text-right tabular-nums">−{String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="text-[10px] text-zinc-400">
                Generated {new Date(scheme.generatedAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewProgress({ elapsed, issues, progress }: { elapsed: number; issues: Issue[]; progress: ReviewProgress | null }) {
  const ruleCount = progress?.ruleCount ?? issues.filter((i) => i.source === "RULE").length;
  const agentCount = progress?.agentCount ?? issues.filter((i) => i.source === "AGENT").length;
  const stage = progress?.message || stageLabel(progress?.stage, elapsed, agentCount);

  // Stage-driven progress so the bar reflects WHERE we are, not just how long
  // we've waited. Each stage gets a band; within the band the bar nudges
  // forward with elapsed so users still see motion during long Claude calls.
  const band = stageBand(progress?.stage);
  const within = Math.min(1, (elapsed % 60) / 60); // soft 0..1 sweep each minute
  const pct = Math.round(band.start + (band.end - band.start) * within);

  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-sm flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-blue-900">{stage}</span>
            <span className="text-xs text-blue-700">
              {elapsed}s elapsed · {band.label}
              {progress?.stage === "marking-running" || progress?.stage === "agent-running"
                ? " — still working (Claude can take 60–180s per call)"
                : ""}
            </span>
          </div>
          <div className="h-1.5 bg-blue-100 rounded overflow-hidden relative">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-400/40 to-transparent animate-[pulse_2s_ease-in-out_infinite]" />
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
            ✓ Rules: {ruleCount}
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800">
            ⏳ AI: {agentCount}
          </span>
        </div>
      </div>
    </div>
  );
}

function statusBadgeClass(status: Report["status"]): string {
  switch (status) {
    case "UPLOADED":  return "bg-zinc-100 text-zinc-700 border border-zinc-200";
    case "REVIEWING": return "bg-blue-100 text-blue-800 border border-blue-200";
    case "REVIEWED":  return "bg-amber-100 text-amber-800 border border-amber-200";
    case "APPROVED":  return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    case "SENT":      return "bg-violet-100 text-violet-800 border border-violet-200";
    default:          return "bg-zinc-100 text-zinc-700 border border-zinc-200";
  }
}

function stageBand(stage: ReviewProgress["stage"] | undefined): { start: number; end: number; label: string } {
  switch (stage) {
    case "starting":         return { start: 2,  end: 10, label: "queued" };
    case "rules-done":       return { start: 10, end: 20, label: "rule pass done" };
    case "agent-running":    return { start: 20, end: 65, label: "semantic review in progress" };
    case "agent-done":       return { start: 65, end: 72, label: "issues saved" };
    case "marking-running":  return { start: 72, end: 95, label: "computing marks" };
    case "reviewed":         return { start: 100, end: 100, label: "done" };
    case "failed":           return { start: 100, end: 100, label: "failed" };
    default:                 return { start: 5,  end: 30, label: "starting" };
  }
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "animate-spin" : ""}
    >
      <path d="M21 12a9 9 0 1 1-3.34-7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function stageLabel(stage: ReviewProgress["stage"] | undefined, elapsed: number, agentCount: number): string {
  switch (stage) {
    case "starting": return "Starting Claude review…";
    case "rules-done": return "Rule checks complete — running semantic review (Claude)…";
    case "agent-running": return "Semantic review running (Claude)…";
    case "agent-done": return "Marking + finalizing…";
    case "marking-running": return "Computing marks…";
    case "reviewed": return "Review complete.";
    case "failed": return "Review failed.";
    default:
      return elapsed < 5
        ? "Starting Claude review…"
        : agentCount > 0
          ? "Marking + finalizing…"
          : "Semantic review running (Claude)…";
  }
}

function IssueCard({ issue, isHovered, isActive, selected, onToggleSelect, registerRef, onScrollTo, onUpdate, onDelete }: {
  issue: Issue;
  isHovered: boolean;
  isActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  registerRef: (el: HTMLLIElement | null) => void;
  onScrollTo: () => void;
  onUpdate: (p: Partial<Pick<Issue, "severity" | "category" | "shortDescription">>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.shortDescription);
  const [sev, setSev] = useState(issue.severity);
  const [cat, setCat] = useState(issue.category);
  return (
    <li
      ref={registerRef}
      onClick={onScrollTo}
      className={`rounded border p-2 text-sm cursor-pointer transition-shadow ${
        isActive
          ? "border-blue-500 bg-blue-50/60 ring-2 ring-blue-400 shadow"
          : isHovered
            ? "border-zinc-900"
            : selected
              ? "border-blue-300 bg-blue-50/30"
              : "border-zinc-200"
      }`}
    >
      <div className="flex items-center gap-1 mb-1">
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className="mr-1"
          title="Select for bulk delete"
        />
        <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${issue.severity === "CRITICAL" ? "bg-red-100 text-red-800" : "bg-orange-100 text-orange-800"}`}>{issue.severity}</span>
        <span className="text-[10px] uppercase text-zinc-500">{issue.category}</span>
        <span className={`text-[10px] uppercase ml-auto px-1.5 py-0.5 rounded ${
          issue.source === "RULE" ? "bg-emerald-100 text-emerald-800" :
          issue.source === "AGENT" ? "bg-amber-100 text-amber-800" :
          "bg-zinc-200 text-zinc-700"
        }`}>{issue.source}</span>
      </div>
      {!editing ? (
        <>
          <div className="text-zinc-800">{issue.shortDescription}</div>
          {issue.quotedText && <div className="text-xs text-zinc-500 italic mt-1 truncate">"{issue.quotedText}"</div>}
          <div className="flex gap-3 mt-2 text-xs">
            <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="text-blue-600 hover:underline">Edit</button>
            <button onClick={(e) => { e.stopPropagation(); if (confirm("Delete this comment?")) onDelete(); }} className="text-red-600 hover:underline">Delete</button>
          </div>
        </>
      ) : (
        <div onClick={(e) => e.stopPropagation()} className="space-y-1">
          <div className="flex gap-1">
            <select value={sev} onChange={(e) => setSev(e.target.value as Severity)} className="text-xs rounded border-zinc-300">
              <option value="CRITICAL">Critical</option>
              <option value="MAJOR">Major</option>
            </select>
            <select value={cat} onChange={(e) => setCat(e.target.value as Category)} className="text-xs rounded border-zinc-300">
              <option value="GRAMMAR">Grammar</option>
              <option value="FORMAT">Format</option>
              <option value="COMPLETENESS">Completeness</option>
              <option value="SECTION_QUALITY">Section quality</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className="w-full text-xs rounded border-zinc-300" />
          <div className="flex gap-2">
            <button onClick={async () => { await onUpdate({ shortDescription: draft, severity: sev, category: cat }); setEditing(false); }} className="text-xs rounded bg-zinc-900 text-white px-2 py-1">Save</button>
            <button onClick={() => { setEditing(false); setDraft(issue.shortDescription); }} className="text-xs text-zinc-500">Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

function NewIssueCard({ draft, onChangeDraft, onCancel, onSave }: {
  draft: { quotedText: string; startOffset: number; endOffset: number };
  onChangeDraft: (d: { quotedText: string; startOffset: number; endOffset: number }) => void;
  onCancel: () => void;
  onSave: (payload: { startOffset: number; endOffset: number; quotedText: string; severity: Severity; category: Category; shortDescription: string }) => Promise<void>;
}) {
  const [sev, setSev] = useState<Severity>("MAJOR");
  const [cat, setCat] = useState<Category>("OTHER");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wide text-blue-800 font-medium">New issue</div>
        <button onClick={onCancel} className="ml-auto text-zinc-500 hover:text-zinc-800 text-lg leading-none" aria-label="Cancel">×</button>
      </div>
      <label className="text-[10px] uppercase tracking-wide text-zinc-600">
        Quoted text
        <textarea
          value={draft.quotedText}
          onChange={(e) => onChangeDraft({ ...draft, quotedText: e.target.value, endOffset: draft.startOffset + e.target.value.length })}
          rows={2}
          placeholder="Paste or type a span from the report"
          className="w-full mt-0.5 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-900 normal-case tracking-normal"
        />
      </label>
      <div className="flex gap-2">
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
          Severity
          <select value={sev} onChange={(e) => setSev(e.target.value as Severity)} className="rounded border-zinc-300 text-xs">
            <option value="CRITICAL">Critical</option>
            <option value="MAJOR">Major</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-600 flex-1">
          Category
          <select value={cat} onChange={(e) => setCat(e.target.value as Category)} className="rounded border-zinc-300 text-xs">
            <option value="GRAMMAR">Grammar</option>
            <option value="FORMAT">Format</option>
            <option value="COMPLETENESS">Completeness</option>
            <option value="SECTION_QUALITY">Section quality</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
      </div>
      <label className="text-[10px] uppercase tracking-wide text-zinc-600">
        Description
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={2}
          placeholder="What's wrong here?"
          className="w-full mt-0.5 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-900 normal-case tracking-normal"
          autoFocus
        />
      </label>
      {err && <div className="text-[11px] text-red-700">{err}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} disabled={busy} className="text-xs rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100">Cancel</button>
        <button
          disabled={busy || !desc.trim() || !draft.quotedText.trim()}
          onClick={async () => {
            setBusy(true); setErr(null);
            try {
              await onSave({
                startOffset: draft.startOffset,
                endOffset: draft.endOffset,
                quotedText: draft.quotedText.trim(),
                severity: sev,
                category: cat,
                shortDescription: desc.trim(),
              });
            } catch (e: any) {
              setErr(e.message || "Failed");
            } finally {
              setBusy(false);
            }
          }}
          className="text-xs rounded bg-zinc-900 text-white px-2.5 py-1 disabled:opacity-50"
        >{busy ? "Saving…" : "Add issue"}</button>
      </div>
    </div>
  );
}

function computeOffset(root: HTMLElement | null, node: Node, off: number): number {
  if (!root) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    if (cur === node) return total + off;
    total += (cur as Text).data.length;
    cur = walker.nextNode();
  }
  return total;
}

// Normalize a section number ("3.1", "3.1.", "3 .1") to a stable id slug.
function sectionId(num: string): string {
  return "sec-" + num.replace(/\s+/g, "").replace(/\.+$/, "");
}

// Scan rendered HTML and:
//   1. Tag headings that start with a numeric prefix (e.g. "3.1 Methodology")
//      with id="sec-3.1" so anchors can link to them.
//   2. Detect TOC paragraphs that end with leader dots + a page number
//      (e.g. "3.1 Methodology .......... 12") and wrap them in <a href="#sec-3.1">
//      so clicking jumps to the section, mimicking Word/Excel TOC behavior.
function enhanceHeadingsAndToc(root: HTMLElement) {
  const headingNumRe = /^(\d+(?:\.\d+){0,4})\.?\s+(.+?)\s*$/;
  // Leader can be dots, tabs, or 2+ spaces between the title and the page number.
  const tocLineRe = /^(\d+(?:\.\d+){0,4})\.?\s+(.+?)(?:[.\t]{2,}|\s{2,})(\d{1,4})\s*$/;
  const tocNoNumRe = /^(.+?)(?:[.\t]{2,}|\s{2,})(\d{1,4})\s*$/;

  // Pass 1: ID assignment on real headings.
  const heads = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  heads.forEach((h) => {
    const txt = (h.textContent || "").trim();
    const m = headingNumRe.exec(txt);
    if (m && !h.id) h.id = sectionId(m[1]);
  });

  // Fallback: numbered headings rendered as plain <p> (common from PDF ingest).
  // Treat a short paragraph whose entire content starts with N.N* as a heading
  // anchor (assign id, do not change tag).
  const blocks = root.querySelectorAll<HTMLElement>("p, div");
  blocks.forEach((p) => {
    if (p.id) return;
    const txt = (p.textContent || "").trim();
    if (txt.length > 120) return;
    if (tocLineRe.test(txt)) return; // skip TOC lines themselves
    const m = headingNumRe.exec(txt);
    if (m) p.id = sectionId(m[1]);
  });

  // Pass 2: rewrite TOC lines into clickable anchors.
  blocks.forEach((p) => {
    if (p.querySelector("a.rr-toc-link")) return; // already linked
    if (p.children.length === 1 && p.children[0].tagName === "A") return; // mammoth-wrapped TOC entry
    const txt = (p.textContent || "").trim();
    // Quick reject: must end with a page-number-looking suffix.
    if (!/(?:[.\t]{2,}|\s{2,})\d{1,4}\s*$/.test(txt) && !/\s\d{1,4}\s*$/.test(txt)) return;

    const numMatch = tocLineRe.exec(txt);
    const fallbackMatch = numMatch ? null : tocNoNumRe.exec(txt);
    if (!numMatch && !fallbackMatch) return;

    let targetId: string | null = null;
    if (numMatch) {
      targetId = sectionId(numMatch[1]);
    } else if (fallbackMatch) {
      const lookup = fallbackMatch[1].toLowerCase();
      for (const h of Array.from(heads)) {
        if ((h.textContent || "").trim().toLowerCase().includes(lookup)) {
          targetId = h.id || (h.id = `sec-${slugify(h.textContent || "")}`);
          break;
        }
      }
    }
    if (!targetId) return;
    // Don't bother linking if the heading isn't actually present in the doc.
    if (!document.getElementById(targetId)) return;

    const a = document.createElement("a");
    a.href = `#${targetId}`;
    a.className = "rr-toc-link";
    a.dataset.sectionTarget = targetId;
    while (p.firstChild) a.appendChild(p.firstChild);
    p.appendChild(a);
  });

  // Click handler is attached at the document level via the effect below so it
  // survives root.innerHTML resets and doesn't get registered N times.
}

function onTocLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  // Only intercept in-document anchor clicks inside the rendered report.
  if (!a.closest(".rr-doc-wrap")) return;
  const href = a.getAttribute("href") || "";
  if (!href.startsWith("#") || href.length < 2) return;

  // Prefer the explicit target id we stamped during enhancement.
  const id = a.dataset.sectionTarget || decodeURIComponent(href.slice(1));
  let target = document.getElementById(id);

  // mammoth converts Word bookmarks into <a id="_Toc..."></a> with empty content.
  // getElementById finds the inline anchor — fall back to its parent for scroll.
  if (!target) {
    const byName = document.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`);
    if (byName) target = byName as HTMLElement;
  }
  if (!target) return;
  e.preventDefault();
  const scrollTarget = (target.textContent || "").trim() ? target : target.parentElement || target;
  scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" });
  scrollTarget.classList.add("hl-flash");
  setTimeout(() => scrollTarget.classList.remove("hl-flash"), 1200);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function findTextNodeContaining(root: HTMLElement, needle: string): Text | null {
  const norm = needle.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm.length < 3) return null;
  const probe = norm.slice(0, 60);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.nextNode();
  while (n) {
    const t = (n as Text).data.replace(/\s+/g, " ").toLowerCase();
    if (t.includes(probe)) return n as Text;
    n = walker.nextNode();
  }
  return null;
}

function nodeAtCharOffset(root: HTMLElement, offset: number): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n: Node | null = walker.nextNode();
  while (n) {
    const len = (n as Text).data.length;
    if (acc + len >= offset) return n as Text;
    acc += len;
    n = walker.nextNode();
  }
  return null;
}

function applySearchHighlights(root: HTMLElement, query: string): number {
  if (!query || query.length < 2) return 0;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      // Skip text already inside a search highlight to avoid re-wrapping on reruns.
      if (p?.closest("mark.search-hit")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) { targets.push(n as Text); n = walker.nextNode(); }

  let count = 0;
  for (const t of targets) {
    const text = t.data;
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let idx = lower.indexOf(needle, cursor);
    while (idx !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      count++;
      cursor = idx + needle.length;
      idx = lower.indexOf(needle, cursor);
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    t.parentNode?.replaceChild(frag, t);
  }
  return count;
}

function applyHighlights(root: HTMLElement, issues: Issue[]) {
  // For each issue, locate quotedText in the DOM text and wrap the matching range.
  // We process in source order; matches advance a search cursor so duplicates resolve naturally.
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.nextNode();
  while (n) { textNodes.push(n as Text); n = walker.nextNode(); }

  let cursor = 0; // global char index from where to search next
  const sorted = [...issues].sort((a, b) => a.startOffset - b.startOffset);

  for (const iss of sorted) {
    if (!iss.quotedText) continue;
    const needle = iss.quotedText.trim();
    if (!needle) continue;
    const hit = findRange(textNodes, needle, Math.max(cursor, iss.startOffset - 200));
    if (!hit) continue;
    cursor = hit.endGlobal;
    wrapRange(hit.startNode, hit.startOff, hit.endNode, hit.endOff, iss);
  }
}

type Hit = { startNode: Text; startOff: number; endNode: Text; endOff: number; endGlobal: number };

function findRange(nodes: Text[], needle: string, fromGlobal: number): Hit | null {
  // Build cumulative offsets
  let pos = 0;
  const starts: number[] = [];
  for (const t of nodes) { starts.push(pos); pos += t.data.length; }
  const concat = nodes.map((t) => t.data).join("");
  // Normalize whitespace for matching
  const normNeedle = needle.replace(/\s+/g, " ").trim();
  const normHaystack = concat.replace(/\s+/g, " ");
  // Find offset map from normalized -> original
  // Simpler: search in original concat, allowing some whitespace flexibility
  let idx = concat.indexOf(needle, fromGlobal);
  if (idx < 0) idx = concat.indexOf(needle);
  if (idx < 0) {
    // try normalized
    const ni = normHaystack.indexOf(normNeedle, fromGlobal);
    if (ni < 0) return null;
    // Map normalized index back to original — quick approx: same as ni assuming compression similar
    idx = ni;
  }
  const endIdx = idx + needle.length;
  const startInfo = locate(nodes, starts, idx);
  const endInfo = locate(nodes, starts, endIdx);
  if (!startInfo || !endInfo) return null;
  return { startNode: startInfo.node, startOff: startInfo.off, endNode: endInfo.node, endOff: endInfo.off, endGlobal: endIdx };
}

function locate(nodes: Text[], starts: number[], target: number) {
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i];
    const e = s + nodes[i].data.length;
    if (target >= s && target <= e) return { node: nodes[i], off: target - s };
  }
  return null;
}

function wrapRange(startNode: Text, startOff: number, endNode: Text, endOff: number, iss: Issue) {
  const range = document.createRange();
  try {
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
  } catch { return; }
  const mark = document.createElement("mark");
  mark.className = `hl hl-${iss.severity === "CRITICAL" ? "critical" : "major"}`;
  mark.dataset.issueId = iss.id;
  try {
    if (range.startContainer === range.endContainer) {
      range.surroundContents(mark);
    } else {
      // Multi-node: extract contents and wrap
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
  } catch {
    // splitting boundaries failed (probably already inside another mark); skip
  }
}
