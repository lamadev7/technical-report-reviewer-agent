import KnowledgePanel from "@/components/KnowledgePanel";
import { prisma } from "@/lib/db";

const PREVIEW_CHARS = 1200;

function previewHtml(html: string): string {
  return html.length > PREVIEW_CHARS ? html.slice(0, PREVIEW_CHARS) + "…" : html;
}

export default async function KnowledgePage() {
  let templates: { id: string; name: string; createdAt: Date; previewHtml: string }[] = [];
  let samples: { id: string; name: string; quality: "EXCELLENT" | "BAD"; createdAt: Date; previewHtml: string }[] = [];
  try {
    const [t, s] = await Promise.all([
      prisma.kbTemplate.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true, htmlContent: true },
      }),
      prisma.kbSample.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, quality: true, createdAt: true, htmlContent: true },
      }),
    ]);
    templates = t.map((x) => ({ id: x.id, name: x.name, createdAt: x.createdAt, previewHtml: previewHtml(x.htmlContent) }));
    samples = s.map((x) => ({ id: x.id, name: x.name, quality: x.quality, createdAt: x.createdAt, previewHtml: previewHtml(x.htmlContent) }));
  } catch {}

  return (
    <div className="max-w-6xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-4">Knowledge Base</h1>
      <p className="text-zinc-600 text-sm mb-6">
        Upload report templates/formats and sample reports (good and bad). The reviewer agent uses these as ground truth.
      </p>
      <KnowledgePanel initialTemplates={templates as any} initialSamples={samples as any} />
    </div>
  );
}
