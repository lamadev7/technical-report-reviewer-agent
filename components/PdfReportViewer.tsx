"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import type { Issue } from "./ReportViewer";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default function PdfReportViewer({ fileUrl, issues, activeIssueId = null, search = "", onMarkHover, onSearchHitsChange }: { fileUrl: string; issues: Issue[]; activeIssueId?: string | null; search?: string; onMarkHover?: (issue: Issue, rect: { x: number; y: number } | null) => void; onSearchHitsChange?: (count: number) => void }) {
  const [numPages, setNumPages] = useState(0);
  const [width, setWidth] = useState(720);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth) setWidth(Math.min(900, el.clientWidth - 40));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Precompute regex matchers for each issue's quotedText for fast scan in
  // customTextRenderer. When a specific card is selected, narrow the matcher
  // set to only that issue so the rest of the highlights vanish.
  const issueMatchers = useMemo(() => {
    const source = activeIssueId ? issues.filter((i) => i.id === activeIssueId) : issues;
    return source.map((iss) => {
      const needle = iss.quotedText.trim();
      const normalized = needle.replace(/\s+/g, " ");
      return {
        iss,
        regex: new RegExp(escapeRegex(normalized).replace(/\\ /g, "\\s+"), "i"),
      };
    });
  }, [issues, activeIssueId]);

  const searchRegex = useMemo(() => {
    if (!search || search.length < 2) return null;
    return new RegExp(escapeRegex(search), "gi");
  }, [search]);

  // customTextRenderer wraps any substring of a text item that overlaps an issue
  // or matches the current search query. Issue marks are applied first, then
  // search marks are layered onto the remaining text.
  const renderItem = useMemo(() => {
    return ({ str }: { str: string; itemIndex: number }) => {
      if (!str) return str;
      let out = str;
      for (const { iss, regex } of issueMatchers) {
        const m = out.match(regex);
        if (!m) continue;
        const cls = iss.severity === "CRITICAL" ? "pdf-hl-critical" : "pdf-hl-major";
        out = out.replace(
          regex,
          (matched) => `<mark class="${cls}" data-issue-id="${iss.id}">${matched}</mark>`,
        );
        break;
      }
      if (searchRegex) {
        // Only wrap occurrences in text not already inside a <mark>. Cheap way:
        // split by existing tags and apply replace per text fragment.
        out = out.replace(/(<mark[^>]*>[^<]*<\/mark>)|([^<]+)/g, (_, tag, plain) => {
          if (tag) return tag;
          return plain.replace(searchRegex, (m: string) => `<mark class="search-hit">${m}</mark>`);
        });
      }
      return out;
    };
  }, [issueMatchers, searchRegex]);

  // Report search hit count to parent after the text layer paints. Wrapping
  // happens inside react-pdf's text renderer; we observe the DOM here to
  // count rendered marks.
  useEffect(() => {
    if (!onSearchHitsChange) return;
    const root = wrapRef.current;
    if (!root) return;
    const recount = () => {
      const n = root.querySelectorAll("mark.search-hit").length;
      onSearchHitsChange(n);
    };
    recount();
    const obs = new MutationObserver(recount);
    obs.observe(root, { subtree: true, childList: true });
    return () => obs.disconnect();
  }, [search, onSearchHitsChange, numPages]);

  useEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    const findIssueFromEvent = (e: Event) => {
      const t = e.target as HTMLElement;
      const m = t.closest?.("mark[data-issue-id]") as HTMLElement | null;
      if (!m) return null;
      const id = m.dataset.issueId;
      const iss = issues.find((x) => x.id === id);
      return iss ? { iss, el: m } : null;
    };
    const onOver = (e: Event) => {
      const found = findIssueFromEvent(e);
      if (!found || !onMarkHover) return;
      const r = found.el.getBoundingClientRect();
      onMarkHover(found.iss, { x: r.left + r.width / 2, y: r.top });
    };
    const onOut = (e: Event) => {
      const found = findIssueFromEvent(e);
      if (!found || !onMarkHover) return;
      onMarkHover(found.iss, null);
    };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
    };
  }, [issues, onMarkHover]);

  return (
    <div ref={wrapRef} className="pdf-viewer-wrap flex flex-col items-center gap-4 py-4">
      <Document
        file={fileUrl}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        loading={<div className="text-zinc-500 text-sm py-8">Loading PDF…</div>}
        error={<div className="text-red-600 text-sm py-8">Failed to load PDF.</div>}
        // Internal link clicks (TOC bookmarks in the PDF) fire here with the
        // resolved destination page. Scroll the host container to that page.
        onItemClick={({ pageNumber }: { pageNumber?: number }) => {
          if (!pageNumber) return;
          const pageEl = wrapRef.current?.querySelector<HTMLDivElement>(
            `.react-pdf__Page[data-page-number="${pageNumber}"]`,
          );
          if (pageEl) pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      >
        {Array.from({ length: numPages }).map((_, i) => (
          <Page
            key={`p${i}`}
            pageNumber={i + 1}
            width={width}
            renderTextLayer
            renderAnnotationLayer
            customTextRenderer={renderItem as any}
            className="bg-white shadow-sm border border-zinc-200"
          />
        ))}
      </Document>
    </div>
  );
}
