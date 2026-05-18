import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = `
* { box-sizing: border-box; }
body { font: 12px/1.55 -apple-system, system-ui, "Segoe UI", sans-serif; color: #111; background: #fff; margin: 0; padding: 28px 32px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; text-transform: uppercase; letter-spacing: .04em; color: #555; }
.meta { color: #555; font-size: 11px; margin-bottom: 4px; }
.summary { display: flex; gap: 12px; margin-top: 10px; }
.summary > div { flex: 1; border: 1px solid #e5e5e5; border-radius: 4px; padding: 8px 10px; }
.summary .num { font-size: 18px; font-weight: 600; }
.summary .lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .05em; }
.mark-card { border: 1px solid #fcd34d; background: #fffbeb; border-radius: 4px; padding: 8px 12px; margin-top: 8px; }
.mark-card .overall { font-size: 18px; font-weight: 600; }
.mark-card table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
.mark-card td { padding: 3px 0; border-bottom: 1px dashed #eee; }
.mark-card td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.issues { display: flex; flex-direction: column; gap: 8px; }
.issue { border: 1px solid #e5e5e5; border-radius: 4px; padding: 10px 12px; page-break-inside: avoid; }
.issue.critical { border-left: 4px solid #ef4444; }
.issue.major    { border-left: 4px solid #f97316; }
.issue .tags { display: flex; gap: 6px; align-items: center; font-size: 10px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
.issue .sev-critical { background: #fee2e2; color: #991b1b; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.issue .sev-major    { background: #ffedd5; color: #9a3412; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.issue .cat { background: #f3f4f6; color: #444; padding: 1px 6px; border-radius: 3px; }
.issue .src { margin-left: auto; color: #666; }
.issue .desc { font-size: 12px; }
.issue .quote { font-size: 11px; color: #555; font-style: italic; border-left: 2px solid #d1d5db; padding-left: 8px; margin-top: 6px; word-wrap: break-word; }
.empty { color: #888; font-style: italic; }
.footer { margin-top: 28px; font-size: 10px; color: #888; text-align: center; }
@page { margin: 14mm 12mm; }
`;

type IssueRow = {
  startOffset: number;
  endOffset: number;
  quotedText: string;
  severity: "CRITICAL" | "MAJOR";
  category: string;
  shortDescription: string;
  source: string;
};

export async function exportReviewPdf({
  filename,
  studentName,
  studentEmail,
  status,
  reviewMode,
  markingMode,
  marking,
  issues,
  generatedAt,
}: {
  filename: string;
  studentName: string | null;
  studentEmail: string | null;
  status: string;
  reviewMode: string;
  markingMode: string;
  marking: { overall: number; perSection?: Array<{ title: string; score: number; note?: string }> } | null;
  issues: IssueRow[];
  generatedAt: Date;
}): Promise<Buffer> {
  const counts = {
    total: issues.length,
    critical: issues.filter((i) => i.severity === "CRITICAL").length,
    major: issues.filter((i) => i.severity === "MAJOR").length,
    rule: issues.filter((i) => i.source === "RULE").length,
    agent: issues.filter((i) => i.source === "AGENT").length,
    reviewer: issues.filter((i) => i.source === "REVIEWER").length,
  };

  const issueHtml = issues.length
    ? issues
        .map((i) => {
          const sevCls = i.severity === "CRITICAL" ? "critical" : "major";
          const sevBadge = i.severity === "CRITICAL" ? "sev-critical" : "sev-major";
          return `
        <div class="issue ${sevCls}">
          <div class="tags">
            <span class="${sevBadge}">${escapeHtml(i.severity)}</span>
            <span class="cat">${escapeHtml(i.category)}</span>
            <span class="src">${escapeHtml(i.source)}</span>
          </div>
          <div class="desc">${escapeHtml(i.shortDescription)}</div>
          ${i.quotedText ? `<div class="quote">"${escapeHtml(i.quotedText.slice(0, 600))}"</div>` : ""}
        </div>`;
        })
        .join("")
    : `<div class="empty">No issues recorded.</div>`;

  const markingHtml = marking
    ? `<div class="mark-card">
        <div class="lbl">Marking · reviewer-only</div>
        <div class="overall">${marking.overall}/100</div>
        ${
          marking.perSection?.length
            ? `<table>${marking.perSection
                .map(
                  (s) =>
                    `<tr><td>${escapeHtml(s.title)}${s.note ? ` <span style="color:#777">— ${escapeHtml(s.note)}</span>` : ""}</td><td>${s.score}</td></tr>`,
                )
                .join("")}</table>`
            : ""
        }
      </div>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <h1>Review Report</h1>
    <div class="meta">${escapeHtml(filename)}${studentName ? ` · ${escapeHtml(studentName)}` : ""}${studentEmail ? ` · ${escapeHtml(studentEmail)}` : ""}</div>
    <div class="meta">Status: ${escapeHtml(status)} · Review mode: ${escapeHtml(reviewMode)} · Marking mode: ${escapeHtml(markingMode)} · Generated: ${escapeHtml(generatedAt.toISOString())}</div>

    <div class="summary">
      <div><div class="num">${counts.total}</div><div class="lbl">Total issues</div></div>
      <div><div class="num">${counts.critical}</div><div class="lbl">Critical</div></div>
      <div><div class="num">${counts.major}</div><div class="lbl">Major</div></div>
      <div><div class="num">${counts.rule} / ${counts.agent} / ${counts.reviewer}</div><div class="lbl">Rule / AI / You</div></div>
    </div>

    ${markingHtml}

    <h2>Issues (${issues.length})</h2>
    <div class="issues">${issueHtml}</div>

    <div class="footer">Generated by Report Reviewer Agent</div>
  </body></html>`;

  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return pdf;
  } finally {
    await ctx.close();
  }
}
