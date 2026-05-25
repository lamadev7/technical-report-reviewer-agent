// Shared section-equivalence groups for structural detection. Used by:
//   - lib/checks/requiredSections.ts (rule-based pre-flight)
//   - components/ReportViewer.tsx (marking-scheme modal "in report" check)
//   - lib/agent/skills.ts (mirrored as natural language in the LLM prompt)
//
// Keep these three sources in sync when adding a new equivalence group.

export type SectionGroup = {
  canonical: string;
  synonyms: string[];
  // Optional groups never raise a missing-section issue even when expected by
  // the template (e.g. Bibliography is acceptable but not required when
  // References is present).
  optional?: boolean;
};

export const SECTION_GROUPS: SectionGroup[] = [
  {
    canonical: "Cover Page",
    synonyms: [
      "cover page", "front page", "title page",
      "submitted by", "supervised by", "supervisor",
      "bachelor of", "master of",
      "in partial fulfilment", "in partial fulfillment",
    ],
  },
  {
    canonical: "Title and Declaration Sheet",
    synonyms: [
      "title and declaration sheet", "declaration sheet", "declaration",
      "student declaration", "authorship declaration",
      "statement of originality", "originality declaration",
      "i hereby declare", "i declare that",
    ],
  },
  { canonical: "Abstract", synonyms: ["abstract", "executive summary", "summary"] },
  { canonical: "Acknowledgements", synonyms: ["acknowledgements", "acknowledgments", "acknowledgement"] },
  { canonical: "Table of Contents", synonyms: ["table of contents", "contents", "toc"] },
  { canonical: "List of Figures", synonyms: ["list of figures", "table of figures", "figures"] },
  { canonical: "List of Tables", synonyms: ["list of tables", "table of tables", "tables"] },
  { canonical: "Abbreviations", synonyms: ["abbreviations", "acronyms", "glossary", "list of abbreviations"] },
  { canonical: "Introduction", synonyms: ["introduction", "background and introduction", "project introduction"] },
  {
    canonical: "Literature Review",
    synonyms: ["literature review", "related work", "background", "state of the art", "literature survey"],
  },
  { canonical: "Methodology", synonyms: ["methodology", "methods", "approach", "research method", "research methodology"] },
  { canonical: "Design", synonyms: ["design", "system design", "architecture", "solution design", "high-level design", "low-level design"] },
  { canonical: "Implementation", synonyms: ["implementation", "development", "build", "realisation", "realization"] },
  { canonical: "Testing", synonyms: ["testing", "evaluation", "validation", "quality assurance", "test plan", "test cases"] },
  { canonical: "Results", synonyms: ["results", "findings", "outcomes"] },
  { canonical: "Discussion", synonyms: ["discussion"] },
  {
    canonical: "Conclusion",
    synonyms: ["conclusion", "conclusions", "summary and conclusion", "discussion and conclusion", "conclusion and future work"],
  },
  {
    canonical: "Future Work",
    synonyms: ["future work", "future enhancements", "future scope", "recommendations", "further work"],
  },
  {
    canonical: "References",
    // Bibliography ≡ References per skill rules. Either direction satisfies.
    synonyms: [
      "references", "references and bibliography", "bibliography",
      "works cited", "list of references", "reference list",
    ],
  },
  {
    canonical: "Bibliography",
    synonyms: ["bibliography"],
    optional: true,
  },
  { canonical: "Appendix", synonyms: ["appendix", "appendices", "annex", "annexure"] },
];

const STOPWORDS = new Set(["and", "&", "of", "the", "a", "an", "to", "for"]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*(?:chapter|section)\s+[ivxlcdm0-9]+\s*[—\-:.]?\s*/i, "")
    .replace(/^\s*\d+(?:\.\d+)*\.?\s*/, "")
    .replace(/[.:;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

export function findGroup(headingRaw: string): SectionGroup | null {
  const norm = normalize(headingRaw);
  for (const g of SECTION_GROUPS) {
    if (g.synonyms.includes(norm)) return g;
  }
  const tn = tokens(norm);
  if (!tn.length) return null;
  for (const g of SECTION_GROUPS) {
    for (const syn of g.synonyms) {
      const ts = tokens(syn);
      if (!ts.length) continue;
      if (tn.every((t) => ts.includes(t))) return g;
      if (ts.every((t) => tn.includes(t))) return g;
    }
  }
  return null;
}

export function extractHeadings(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    const numbered = /^\d+(?:\.\d+)*\.?\s+(.+?)\s*$/.exec(t);
    if (numbered) {
      out.add(numbered[1]);
      continue;
    }
    if (/^[A-Z][A-Z\s/&\-]{2,}$/.test(t) && t.length < 80) {
      out.add(t);
    }
  }
  return [...out].map(normalize);
}

export type PresenceResult =
  | { present: true; reason: string; matchedVia: string }
  | { present: false; reason: string; triedSynonyms: string[]; group: SectionGroup | null };

// Explain whether `heading` from a template is present in the report. Returns
// human-readable `reason` for both branches — used as a tooltip in the marking
// scheme modal and in test assertions.
export function explainPresence(heading: string, reportText: string): PresenceResult {
  const reportLower = reportText.toLowerCase();
  const reportHeadingsNorm = new Set(extractHeadings(reportText));
  const norm = normalize(heading);

  // Branch 1: heading itself appears verbatim in report headings.
  if (reportHeadingsNorm.has(norm)) {
    return {
      present: true,
      reason: `Exact heading "${heading}" found in the report.`,
      matchedVia: heading,
    };
  }

  // Branch 2: heading belongs to an equivalence group → check any synonym.
  const group = findGroup(heading);
  const synonymsTried = group ? group.synonyms : [norm];

  for (const syn of synonymsTried) {
    const synNorm = normalize(syn);
    if (reportHeadingsNorm.has(synNorm)) {
      return {
        present: true,
        reason: `Found equivalent heading "${syn}" in the report — same section role as "${heading}".`,
        matchedVia: syn,
      };
    }
    const synTokens = tokens(synNorm);
    if (synTokens.length) {
      for (const rh of reportHeadingsNorm) {
        const rhTokens = tokens(rh);
        if (
          synTokens.every((t) => rhTokens.includes(t)) ||
          (rhTokens.length && rhTokens.every((t) => synTokens.includes(t)))
        ) {
          return {
            present: true,
            reason: `Report heading "${rh}" overlaps with synonym "${syn}" — same section role.`,
            matchedVia: rh,
          };
        }
      }
    }
    if (synNorm.length >= 5 && reportLower.includes(synNorm)) {
      return {
        present: true,
        reason: `Phrase "${syn}" found in the report body (not as a heading) — counts as present.`,
        matchedVia: syn,
      };
    }
  }

  // Special declaration fallback — text extraction often loses the actual
  // declaration heading but keeps the first line of the declaration text.
  if (group?.canonical === "Title and Declaration Sheet") {
    const head = reportLower.slice(0, 8000);
    const m = /\b(i hereby declare|i declare that|statement of originality)\b/.exec(head);
    if (m) {
      return {
        present: true,
        reason: `Found declaration phrase "${m[1]}" in the first pages — counts as a declaration block even without a heading.`,
        matchedVia: m[1],
      };
    }
  }

  // Cover page fallback — first few lines often have "Submitted by" / "University of …".
  if (group?.canonical === "Cover Page") {
    const head = reportLower.slice(0, 4000);
    const m = /\b(submitted by|bachelor of|master of|university of|supervisor)\b/.exec(head);
    if (m) {
      return {
        present: true,
        reason: `Found cover-page keyword "${m[1]}" in the first pages — counts as a cover page.`,
        matchedVia: m[1],
      };
    }
  }

  // Truly missing — explain WHAT was searched.
  const triedList = synonymsTried.slice(0, 6);
  const more = synonymsTried.length > triedList.length ? ` (+${synonymsTried.length - triedList.length} more)` : "";
  return {
    present: false,
    reason: group
      ? `Couldn't find this section in the report. Searched for headings or text matching: ${triedList
          .map((s) => `"${s}"`)
          .join(", ")}${more}. Bibliography is optional, but the template expects "${group.canonical}". Check the report's structure.`
      : `Couldn't find heading "${heading}" or any obvious synonym in the report. Either the section is missing, or its heading wording differs significantly from the template.`,
    triedSynonyms: synonymsTried,
    group,
  };
}
