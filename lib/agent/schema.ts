import { z } from "zod";

export const Severity = z.enum(["CRITICAL", "MAJOR"]);
export const Category = z.enum(["GRAMMAR", "FORMAT", "COMPLETENESS", "SECTION_QUALITY", "OTHER"]);

export const IssueSchema = z.object({
  // Offsets are optional: the model can't realistically count chars in a
  // 60k-char blob. Reviewer snaps offsets server-side from quotedText.
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  // Coerce overruns instead of failing the whole batch — some providers
  // (notably Gemini) ignore the cap and return whole paragraphs as the quote.
  // Truncating still leaves a unique prefix indexOf can match against the
  // report text for offset snapping.
  quotedText: z.preprocess(
    (v) => (typeof v === "string" && v.length > 500 ? v.slice(0, 497) + "..." : v),
    z.string().min(1).max(500),
  ),
  severity: Severity,
  category: Category,
  shortDescription: z.preprocess(
    (v) => (typeof v === "string" && v.length > 200 ? v.slice(0, 197) + "..." : v),
    z.string().min(1).max(200),
  ),
});

export const ReviewOutputSchema = z.object({
  issues: z.array(IssueSchema).max(120),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
export type IssueOut = z.infer<typeof IssueSchema>;

export const MarkingOutputSchema = z.object({
  overall: z.number().min(0).max(100),
  // Some models (notably Claude on terse marking prompts) occasionally omit
  // perSection entirely. Treat missing/null as an empty list so a valid
  // overall score isn't thrown away — downstream UI already handles [] via
  // optional chaining and the recompute pass adds per-section weights when
  // a template scheme is attached.
  perSection: z
    .preprocess(
      (v) => (v === undefined || v === null ? [] : v),
      z.array(
        z.object({
          title: z.preprocess(
            (v) => (typeof v === "string" && v.length > 120 ? v.slice(0, 117) + "..." : v),
            z.string().min(1).max(120),
          ),
          score: z.number().min(0).max(100),
          note: z.preprocess(
            (v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 297) + "..." : v),
            z.string().max(300).optional(),
          ),
        }),
      ).max(20),
    )
    .default([]),
});
export type MarkingOutput = z.infer<typeof MarkingOutputSchema>;

export const reviewToolSchema = {
  name: "report_issues",
  description:
    "Submit the list of CRITICAL and MAJOR issues found in the report. Skip minor issues. shortDescription must be a brief problem description only (no solutions). quotedText must be the exact substring from the report that contains the issue.",
  input_schema: {
    type: "object" as const,
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            quotedText: { type: "string", maxLength: 500, description: "Exact substring from the report containing the issue (<=300 chars preferred, hard cap 500). Offsets are computed server-side." },
            severity: { type: "string", enum: ["CRITICAL", "MAJOR"] },
            category: { type: "string", enum: ["GRAMMAR", "FORMAT", "COMPLETENESS", "SECTION_QUALITY", "OTHER"] },
            shortDescription: { type: "string", maxLength: 200, description: "<=200 char problem description, no fix" },
          },
          required: ["quotedText", "severity", "category", "shortDescription"],
        },
      },
    },
    required: ["issues"],
  },
};

export const markingToolSchema = {
  name: "submit_marking",
  description: "Submit overall score (0-100) and per-section scores for this report.",
  input_schema: {
    type: "object" as const,
    properties: {
      overall: { type: "number", minimum: 0, maximum: 100 },
      perSection: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 120 },
            score: { type: "number", minimum: 0, maximum: 100 },
            note: { type: "string", maxLength: 300 },
          },
          required: ["title", "score"],
        },
      },
    },
    required: ["overall"],
  },
};
