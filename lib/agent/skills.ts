// A "skill" is a focused review directive injected into the system prompt.
// Skills steer the agent toward a specific kind of issue and AWAY from
// out-of-scope nits (e.g. flagging that the report topic differs from a
// template's example topic — the template is a structural guide, not a
// content match).

export type SkillDef = {
  id: string;
  name: string;
  // Human-facing one-liner — shown in the UI multiselect.
  blurb: string;
  // Inserted into the system prompt when this skill is enabled.
  instructions: string;
  // Default-on for new reports.
  defaultOn: boolean;
};

export const SKILLS: SkillDef[] = [
  {
    id: "structure-compliance",
    name: "Structure compliance",
    blurb: "Required sections present in expected order",
    defaultOn: true,
    instructions: [
      "Skill: STRUCTURE COMPLIANCE.",
      "- Compare the report's SECTION OUTLINE to the template's outline.",
      "- Flag missing required sections, missing required subsections, and major out-of-order sections.",
      "- DO NOT flag a section just because its body content differs from the template — the template is a structural guide, not a content match.",
    ].join("\n"),
  },
  {
    id: "format-style",
    name: "Format & style",
    blurb: "Heading hierarchy, list style, citation/reference format",
    defaultOn: true,
    instructions: [
      "Skill: FORMAT & STYLE.",
      "- Flag heading-hierarchy mismatches (e.g. template uses numbered headings, report uses inline bold).",
      "- Flag inconsistent list/bullet style, table layout, and citation format vs the template.",
      "- DO NOT flag the report's choice of subject, topic, words, or examples — only formatting.",
    ].join("\n"),
  },
  {
    id: "grammar-prose",
    name: "Grammar & prose",
    blurb: "Severe grammar/syntax errors that block meaning",
    defaultOn: true,
    instructions: [
      "Skill: GRAMMAR & PROSE.",
      "- Flag SEVERE grammar/syntax issues that block meaning (broken sentences, agreement errors, run-ons).",
      "- DO NOT report minor preference nits, regional spelling, or already-flagged rule-pass items.",
    ].join("\n"),
  },
  {
    id: "section-depth",
    name: "Section depth",
    blurb: "Each section has substantive content, not a heading shell",
    defaultOn: true,
    instructions: [
      "Skill: SECTION DEPTH.",
      "- Flag sections/subsections that are heading-only, one-line filler, or off-topic for the heading.",
      "- Flag missing rationale where one is required (e.g. methodology section without justification).",
      "- DO NOT compare the depth to the template's example depth — judge each section on its own merit.",
    ].join("\n"),
  },
  {
    id: "originality",
    name: "Originality / plagiarism",
    blurb: "Verbatim copy from samples or boilerplate",
    defaultOn: true,
    instructions: [
      "Skill: ORIGINALITY.",
      "- Flag verbatim or near-verbatim copy from a calibration sample, especially from EXCELLENT samples used as references.",
      "- Flag suspiciously generic boilerplate that contains no project-specific detail.",
    ].join("\n"),
  },
  {
    id: "reference-quality",
    name: "Reference quality",
    blurb: "Citations present, formatted, and referenced in text",
    defaultOn: false,
    instructions: [
      "Skill: REFERENCE QUALITY.",
      "- Flag missing References / Bibliography section if any in-text citations exist.",
      "- Flag inconsistent citation format (mix of [1] and (Author, YYYY)).",
      "- Flag in-text citations that have no matching entry in the references list.",
    ].join("\n"),
  },
  {
    id: "factual-plausibility",
    name: "Factual plausibility",
    blurb: "Obvious factual errors or contradictory claims",
    defaultOn: false,
    instructions: [
      "Skill: FACTUAL PLAUSIBILITY.",
      "- Flag claims that are obviously false, internally contradictory, or unsupported by any source.",
      "- DO NOT flag domain-specific claims you cannot verify — only obvious errors.",
    ].join("\n"),
  },
  {
    id: "literature-review",
    name: "Literature review validity",
    blurb: "Validate citations, in-text/ref matching, fabrication signals",
    defaultOn: false,
    instructions: [
      "Skill: LITERATURE REVIEW VALIDITY.",
      "- Flag references that look fabricated: implausible author/title/year combos, mismatched journal+year, malformed DOIs, or fake-looking URLs.",
      "- Flag in-text citations (e.g. [3], (Smith, 2019)) that have NO matching entry in the references/bibliography list.",
      "- Flag entries in the references list that are NEVER cited in the body.",
      "- Flag suspiciously generic claims attributed to a source with no page/section anchor.",
      "- Flag a literature review section that lists references without discussing or comparing them.",
      "- Flag clearly stale references when the topic demands recent sources (e.g. a survey of modern web frameworks citing only pre-2015 papers).",
      "- DO NOT confirm exact metadata by external lookup — only flag patterns that look invalid on their face.",
    ].join("\n"),
  },
  {
    id: "technical-diagrams",
    name: "Technical diagrams presence",
    blurb: "FDD / Gantt / use-case / sequence / class / ER diagrams referenced and present",
    defaultOn: false,
    instructions: [
      "Skill: TECHNICAL DIAGRAMS PRESENCE.",
      "- Detect text mentions of expected technical diagrams: Functional Decomposition Diagram (FDD), Gantt chart, use case diagram, sequence diagram, activity diagram, class diagram, ER diagram, data flow diagram (DFD), architecture diagram, flowchart, state diagram.",
      "- If the report MENTIONS such a diagram (e.g. 'see Figure X', 'Gantt chart below', 'use case diagram in section Y') but the surrounding text lacks any figure caption (`Figure N:`), rendered placeholder, or table of figures entry, flag as MISSING_DIAGRAM.",
      "- If the template's structure requires one of these diagrams (e.g. template has a 'System Design — Use Case Diagram' section) but the report's corresponding section contains only prose with no figure reference, flag as MISSING_DIAGRAM.",
      "- You CANNOT see images; rely only on textual signals (figure captions, figure references, placeholders, list of figures).",
    ].join("\n"),
  },
  {
    id: "prose-quality",
    name: "Prose quality & depth",
    blurb: "Paragraph length, redundancy, vague claims, missing transitions",
    defaultOn: true,
    instructions: [
      "Skill: PROSE QUALITY & DEPTH.",
      "- Flag paragraphs that are one-sentence stubs in sections requiring depth (Methodology, Design choices, Discussion, Conclusion).",
      "- Flag claims stated without explanation, example, or rationale where the section calls for it.",
      "- Flag redundant content that repeats earlier paragraphs without adding new information.",
      "- Flag vague filler phrases that convey no information (e.g. 'various technologies', 'many features', 'in today's world').",
      "- Flag abrupt topic shifts between paragraphs with no transition.",
      "- DO NOT flag stylistic preferences (e.g. passive voice in methodology is fine).",
    ].join("\n"),
  },
];

export function getSkill(id: string): SkillDef | undefined {
  return SKILLS.find((s) => s.id === id);
}

export function defaultSkillIds(): string[] {
  return SKILLS.filter((s) => s.defaultOn).map((s) => s.id);
}

export function buildSkillsSection(enabledIds: string[]): string {
  const ids = enabledIds.length ? enabledIds : defaultSkillIds();
  const blocks = ids
    .map((id) => getSkill(id))
    .filter((s): s is SkillDef => !!s)
    .map((s) => s.instructions);
  if (!blocks.length) return "";
  return `Enabled review skills (focus your findings on these areas; ignore concerns outside them):\n\n${blocks.join("\n\n")}`;
}
