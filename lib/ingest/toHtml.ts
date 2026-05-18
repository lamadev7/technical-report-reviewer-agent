import mammoth from "mammoth";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type Ingested = {
  html: string;
  plainText: string;
};

const exec = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout: stdout.toString(), stderr: stderr.toString() }),
    ),
  );

export async function ingestBuffer(buf: Buffer, filename: string): Promise<Ingested> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx") return docxToHtml(buf);
  if (ext === ".doc") return docToHtml(buf);
  if (ext === ".pdf") return pdfToHtml(buf);
  throw new Error(`Unsupported file extension: ${ext}`);
}

async function docxToHtml(buf: Buffer): Promise<Ingested> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer: buf },
    { styleMap: ["p[style-name='Title'] => h1.title", "p[style-name='Heading 1'] => h1", "p[style-name='Heading 2'] => h2", "p[style-name='Heading 3'] => h3"] },
  );
  const { value: plainText } = await mammoth.extractRawText({ buffer: buf });
  return { html: wrap(html), plainText };
}

async function docToHtml(buf: Buffer): Promise<Ingested> {
  // libreoffice headless converts .doc -> .docx, then mammoth handles it.
  const tmp = path.join(os.tmpdir(), `rrv-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const srcPath = path.join(tmp, "in.doc");
    await fs.writeFile(srcPath, buf);
    await exec("libreoffice", ["--headless", "--convert-to", "docx", "--outdir", tmp, srcPath]);
    const outPath = path.join(tmp, "in.docx");
    const docxBuf = await fs.readFile(outPath);
    return docxToHtml(docxBuf);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function pdfToHtml(buf: Buffer): Promise<Ingested> {
  // pdf2json is pure JS, no worker spawn — sidesteps Next/Turbopack bundling issues
  // that broke pdfjs-dist's dynamic worker import.
  const mod: any = await import("pdf2json");
  const PDFParser = mod.default || mod;
  const parser = new PDFParser(null, true /* needRawText */);
  const data: any = await new Promise((resolve, reject) => {
    parser.on("pdfParser_dataError", (e: any) => reject(e?.parserError || e));
    parser.on("pdfParser_dataReady", (d: any) => resolve(d));
    parser.parseBuffer(buf);
  });
  const rawText: string = typeof parser.getRawTextContent === "function" ? parser.getRawTextContent() : "";
  const plainText = rawText
    .replace(/----------------Page \(\d+\) Break----------------/g, "\n\n")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  const paragraphs = plainText
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const html = wrap(paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"));
  return { html, plainText };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function wrap(inner: string) {
  return `<div class="rr-doc">${inner}</div>`;
}
