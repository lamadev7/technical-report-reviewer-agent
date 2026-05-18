import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

const CSS = `
body { font: 14px/1.55 -apple-system, system-ui, sans-serif; color: #111; background: #fff; padding: 16px; max-width: 720px; }
.ctx { white-space: pre-wrap; word-wrap: break-word; }
mark.critical { background: rgba(239, 68, 68, 0.32); border-bottom: 2px solid rgb(239, 68, 68); padding: 1px 2px; }
mark.major { background: rgba(249, 115, 22, 0.3); border-bottom: 2px solid rgb(249, 115, 22); padding: 1px 2px; }
.cap { font-size: 12px; color: #666; margin-bottom: 6px; }
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export async function screenshotIssue({
  contextBefore,
  quotedText,
  contextAfter,
  severity,
  category,
  shortDescription,
}: {
  contextBefore: string;
  quotedText: string;
  contextAfter: string;
  severity: "CRITICAL" | "MAJOR";
  category: string;
  shortDescription: string;
}): Promise<Buffer> {
  const cls = severity === "CRITICAL" ? "critical" : "major";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
  <div class="cap">${escapeHtml(severity)} · ${escapeHtml(category)} — ${escapeHtml(shortDescription)}</div>
  <div class="ctx">${escapeHtml(contextBefore)}<mark class="${cls}">${escapeHtml(quotedText)}</mark>${escapeHtml(contextAfter)}</div>
</body></html>`;
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const body = page.locator("body");
  const buf = await body.screenshot({ type: "png", omitBackground: false });
  await ctx.close();
  return buf;
}
