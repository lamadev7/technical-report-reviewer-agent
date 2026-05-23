import { prisma } from "@/lib/db";

// Persisted marking scheme attached to a template. The scheme is the
// deterministic ground truth the marker uses when the LLM marking call is
// unavailable, and it also feeds the LLM as context so its score is anchored
// to the same rubric the human reviewer would apply.
export type MarkingScheme = {
  version: 1;
  totalPoints: 100;
  topics: Array<{
    id: string;           // stable slug like "5-introduction"
    heading: string;      // human-readable title
    weight: number;       // points
    required: boolean;
  }>;
  buckets: {
    topicQuality: number;       // budget across topics; sum of topic weights
    wordCount: number;          // pts awarded when major-content count is in band
    grammar: number;            // pts; deducted -0.5 per 2 errors
    format: number;             // pts; deducted -5 per format break
    explanationQuality: number; // pts; awarded by depth signal (no [under] / [over])
  };
  wordCountBand: { min: number; max: number };
  // Per-issue penalties used in the deterministic recompute.
  penalties: {
    grammar: number;
    format: number;
    completeness: number;
    sectionUnder: number;
    sectionOver: number;
    other: number;
  };
  generatedAt: string;
};

// Extract top-level numbered headings (1. Cover Page, 5.1 Project briefing,
// etc.) from a template's plaintext. PDF extraction is noisy so we accept a
// few formats. We keep ONLY the major (single-segment) numbers as scoreable
// topics so the scheme stays readable; subsections add depth via the agent's
// section-quality skill.
function extractTopics(plain: string): Array<{ number: string; heading: string }> {
  const out = new Map<string, string>();
  // Common top-level section names found in academic project reports. Matching
  // by keyword as a fallback when the numbered-heading parse drops one because
  // of PDF text-extraction noise (line-breaks splitting headings, etc.).
  const KNOWN: Array<[number, RegExp, string]> = [
    [1, /\bCover Page\b/i, "Cover Page"],
    [2, /\bTitle (?:Page|and Declaration)\b/i, "Title and Declaration Sheet"],
    [3, /\bAbstract\b/i, "Abstract"],
    [4, /\b(?:Table of )?Contents\b/i, "Table of Contents"],
    [5, /\bIntroduction\b/i, "Introduction"],
    [6, /\bLiterature Review\b/i, "Literature Review"],
    [7, /\bProject Methodology\b/i, "Project Methodology"],
    [8, /\b(?:Different )?Technology and Tools\b/i, "Technology and Tools"],
    [9, /\bArtefact Design/i, "Artefact Design"],
    [10, /\bConclusion\b/i, "Conclusion"],
    [11, /\bCritical Evaluation\b/i, "Critical Evaluation"],
    [12, /\bEvidence of Project Management\b/i, "Evidence of Project Management"],
    [13, /\bReference(?:s)? (?:and Bibliography|& Bibliography|\/ Bibliography)\b/i, "References and Bibliography"],
    [14, /\bAppendices\b/i, "Appendices"],
  ];

  // Pass 1 — KNOWN canonical headings. PDF text-extraction often shreds
  // numbered-heading lines so we anchor to keyword matches first. This gives
  // us clean, predictable labels for the standard project-report sections.
  for (const [n, re, label] of KNOWN) {
    if (re.test(plain)) out.set(String(n), label);
  }

  // Pass 2 — numbered-heading regex for templates that don't match the
  // KNOWN list (custom report formats, non-English templates, etc.). Only
  // fills gaps left by pass 1.
  const re = /(?:^|[\s.])(\d{1,2})\.\s*([A-Z][A-Za-z][A-Za-z &/\-]{4,80}?)(?=\s*(?:\d+\.|\n|$|[A-Z][a-z]+\s))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > 25) continue;
    const heading = m[2].trim().replace(/\s{2,}/g, " ");
    // Skip obvious truncations (trailing connector words).
    if (/\b(and|of|the|to|for|in|on|with|by|from)$/i.test(heading)) continue;
    if (heading.length < 5) continue;
    if (!out.has(String(n))) out.set(String(n), heading);
  }

  return [...out.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([number, heading]) => ({ number, heading }));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export function generateMarkingScheme({
  plainText,
  wordCountMin = 10000,
  wordCountMax = 12000,
}: {
  plainText: string;
  wordCountMin?: number;
  wordCountMax?: number;
}): MarkingScheme {
  const topicsRaw = extractTopics(plainText);
  // Fallback to a generic outline if the template is too noisy to parse.
  const baseTopics = topicsRaw.length
    ? topicsRaw
    : [
        { number: "1", heading: "Cover Page" },
        { number: "2", heading: "Abstract" },
        { number: "3", heading: "Introduction" },
        { number: "4", heading: "Literature Review" },
        { number: "5", heading: "Methodology" },
        { number: "6", heading: "Artefact Design" },
        { number: "7", heading: "Critical Evaluation" },
        { number: "8", heading: "Conclusion" },
        { number: "9", heading: "References" },
      ];

  // Bucket budgets sum to 100.
  const buckets = {
    topicQuality: 60,
    wordCount: 10,
    grammar: 10,
    format: 15,
    explanationQuality: 5,
  };
  const perTopic = Number((buckets.topicQuality / baseTopics.length).toFixed(2));
  const topics = baseTopics.map((t) => ({
    id: `${t.number}-${slugify(t.heading)}`,
    heading: t.heading,
    weight: perTopic,
    required: true,
  }));

  return {
    version: 1,
    totalPoints: 100,
    topics,
    buckets,
    wordCountBand: { min: wordCountMin, max: wordCountMax },
    penalties: {
      grammar: 0.25,
      format: 5,
      completeness: 5,
      sectionUnder: 1,
      sectionOver: 0.5,
      other: 0.5,
    },
    generatedAt: new Date().toISOString(),
  };
}

// Ensure the template has a marking scheme persisted. Generates one on demand
// when missing (e.g. legacy template uploaded before this feature shipped).
export async function ensureTemplateMarkingScheme(templateId: string): Promise<MarkingScheme | null> {
  const tpl = await prisma.kbTemplate.findUnique({
    where: { id: templateId },
    select: { plainText: true, markingScheme: true },
  });
  if (!tpl) return null;
  if (tpl.markingScheme) return tpl.markingScheme as unknown as MarkingScheme;
  const scheme = generateMarkingScheme({ plainText: tpl.plainText });
  await prisma.kbTemplate.update({
    where: { id: templateId },
    data: { markingScheme: scheme as any },
  });
  return scheme;
}
