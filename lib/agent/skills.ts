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
  // Force-include on every review regardless of the report's enabledSkills.
  // Use for structural rules that must never be disabled (e.g. flexible
  // heading matching — applies to every report).
  alwaysOn?: boolean;
};

export const SKILLS: SkillDef[] = [
  {
    id: "flexible-section-matching",
    name: "Flexible section matching",
    blurb: "Match template sections to report sections by role, not exact title or numbering",
    defaultOn: true,
    alwaysOn: true,
    instructions: [
      "Skill: FLEXIBLE SECTION MATCHING (overrides naive heading comparison — read carefully).",
      "",
      "Goal: decide whether each TEMPLATE section is present in the REPORT by ROLE, not by exact heading text or numbering. A section counts as PRESENT if any one of these is true in the report:",
      "  (a) An exact heading match (case-insensitive, ignoring punctuation, numbering prefixes, and trailing 's').",
      "  (b) A near-synonym heading that serves the same role (see equivalence table below).",
      "  (c) A page or block that fulfils the role even without a heading — typically the first page (cover page), an image / scanned block (declaration sheet), or a clearly labelled list (references).",
      "  (d) VISUAL evidence on pages 1–4 when the report PDF is attached. Many declaration sheets, signature blocks, and cover pages are SCANNED IMAGES; text extraction from those pages is empty or garbled. If the PDF is attached, you MUST inspect the rendered pages 1–4 visually before claiming Cover Page / Declaration / Title Page is missing. A visible logo + title block, or a visible signed declaration, counts as PRESENT — even if no extracted text proves it.",
      "Only flag a section as MISSING when none of (a), (b), (c), or (d) is satisfied.",
      "",
      "Equivalence table — treat these as the SAME section (do not require the exact template wording):",
      "  - Cover Page  ≡  Front Page  ≡  Title Page  ≡  (any first-page block with university/college name or logo + report title + student name + ID + date, with or without a 'Cover Page' heading). If the report's first page carries that signal — even as text-only metadata or a logo placeholder line ('University of …', 'Bachelor of …', 'Submitted by …'), or if the attached PDF's page 1 shows a visible logo + title + author block as an image — Cover Page is PRESENT. DO NOT flag missing 'Cover Page' just because the literal heading is absent.",
      "  - Title and Declaration Sheet  ≡  Declaration  ≡  Declaration Sheet  ≡  Student Declaration  ≡  Statement of Originality  ≡  Authorship Declaration  ≡  any block (heading, paragraph, or image caption) containing the keyword 'declaration', 'declare', or 'I hereby declare'. Image-only declarations count as PRESENT (text extraction may show just a stub caption like 'Declaration' or 'Signed:'). Do not require the full template wording. CRITICAL: declaration sheets are commonly inserted as a scanned/photographed page somewhere between page 1 and page 4 of the PDF. When the PDF is attached, look at the visible images on those pages: a page with a paragraph of 'I hereby declare …' text rendered as part of an image, with a signature box or stamp, IS a declaration sheet — DO NOT flag missing-declaration in that case. Past noisy false-positives: flagging missing Declaration when a signed scan was clearly visible on page 2.",
      "  - References and Bibliography  ≡  References  ≡  Bibliography  ≡  Works Cited  ≡  List of References  ≡  any combination of those headings. PRESENT if EITHER 'References' OR 'Bibliography' (or any equivalent) appears. Bibliography is OPTIONAL — never flag missing-Bibliography on its own. If both appear in either order, that is also PRESENT, not a duplicate.",
      "  - Abstract  ≡  Executive Summary  ≡  Summary.",
      "  - Acknowledgements  ≡  Acknowledgments  ≡  Thanks  ≡  Dedication-and-Acknowledgements (UK/US spelling both fine).",
      "  - Table of Contents  ≡  Contents  ≡  TOC.",
      "  - Table of Figures  ≡  List of Figures  ≡  Figures.",
      "  - Table of Tables  ≡  List of Tables  ≡  Tables.",
      "  - List of Abbreviations  ≡  Abbreviations  ≡  Acronyms  ≡  Glossary (if used as abbreviation list).",
      "  - Introduction  ≡  Background and Introduction  ≡  Project Introduction.",
      "  - Literature Review  ≡  Background  ≡  Related Work  ≡  State of the Art.",
      "  - Methodology  ≡  Methods  ≡  Approach  ≡  Research Method.",
      "  - Design  ≡  System Design  ≡  Architecture  ≡  Solution Design.",
      "  - Implementation  ≡  Development  ≡  Build  ≡  Realisation.",
      "  - Testing  ≡  Evaluation  ≡  Validation  ≡  Quality Assurance (when paired with test cases).",
      "  - Conclusion  ≡  Conclusions  ≡  Summary and Conclusion  ≡  Discussion and Conclusion.",
      "  - Future Work  ≡  Future Enhancements  ≡  Future Scope  ≡  Recommendations.",
      "  - Appendix  ≡  Appendices  ≡  Annex  ≡  Annexure.",
      "",
      "General matching rules (apply BEFORE concluding a section is missing):",
      "  1. Normalize headings before comparison: lowercase, strip punctuation, strip numbering prefixes (e.g. '1.', '1.2.3', 'Chapter 4 —', 'Section II:'), strip 'and', '&', trailing colon, surrounding whitespace, and trailing 's'.",
      "  2. Compare as TOKEN SETS: if every meaningful word in the template heading appears in some report heading (or vice-versa, when the report uses a more specific title like 'Background and Introduction' vs template 'Introduction'), treat them as the same section.",
      "  3. Look BEYOND headings for sections that often appear as images or boilerplate: cover page, declaration sheet, certificate, signature block. Scan the first ~2 pages of text for indicative keywords (university name, 'declare', 'submitted by', 'supervisor', 'date', 'signature') before flagging these as missing.",
      "  4. NUMBERING IS NOT STRUCTURAL — DO NOT compare or flag chapter/section NUMBERS between template and report. If template has '1. Introduction / 2. Literature Review / 3. Methodology' and the report uses '1. Introduction / 2. Methodology / 3. Literature Review', that is NOT a structure violation — both sections exist. Same for '3.2.1' vs 'III.B.1' style differences. Only flag missing/extra sections by ROLE, not by numbering scheme.",
      "  5. Order of optional sections (Bibliography vs References, Acknowledgements vs Abstract) is NOT a violation. Only flag order when a clearly mandatory anchor section (e.g. Conclusion before References) is out of place in a way that breaks reading flow.",
      "  6. If unsure whether a section is present, DO NOT flag — false missing-section claims are the worst class of reviewer noise per the team. Bias towards 'present' when there is any plausible signal.",
      "",
      "When flagging a TRUE missing section, follow the structure-compliance skill format: severity CRITICAL, category FORMAT, quotedText = the missing heading from the template, shortDescription = `Missing required section [TITLE] — required by the template.`. Do NOT include numbering in quotedText.",
    ].join("\n"),
  },
  {
    id: "structure-compliance",
    name: "Structure compliance",
    blurb: "Report follows the template's format end-to-end",
    defaultOn: true,
    instructions: [
      "Skill: STRUCTURE COMPLIANCE (report format vs template) — CRITICAL ENFORCEMENT.",
      "- BUILD an explicit checklist of every heading and required subsection from the template before reading the report. Walk the checklist top-to-bottom and verify each item is present somewhere in the report with matching ROLE (not the same words, the same KIND of section).",
      "- Apply the FLEXIBLE SECTION MATCHING rules above when deciding presence. A section is present if its role exists in the report by heading, near-synonym, OR unheaded boilerplate block (cover page, declaration image, etc.). Do NOT rely on exact heading text.",
      "- Flag EACH genuinely missing required section / required subsection as a SEPARATE CRITICAL · FORMAT issue. quotedText = the missing heading text from the template (no numbering prefix). shortDescription = `Missing required section [TITLE] — required by the template.`",
      "- Also flag, with appropriate severity: mismatched figure/table caption style, citation format mismatched vs template, missing required boilerplate when the template includes one and NO equivalent block is present anywhere in the report.",
      "- If a section heading exists but its body is missing or is a heading-only stub, that is STILL a structure violation — flag as CRITICAL · FORMAT with quotedText = the offending heading.",
      "- DO NOT flag heading-numbering differences (e.g. template '1.2.3' vs report 'II.B.1') as a structure violation. Numbering scheme is presentational only — see FLEXIBLE SECTION MATCHING rule 4.",
      "- DO NOT flag a section because its body content TOPIC differs from the template — the template is a structural guide, not a topic match.",
      "- DO NOT suggest a fix. Depict the format break only and quote the heading so the reviewer can navigate to it.",
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
    blurb: "Context-aware grammar, syntax, and spelling errors",
    defaultOn: true,
    instructions: [
      "Skill: GRAMMAR, SYNTAX & SPELLING.",
      "- Flag grammar/syntax issues: broken sentences, subject-verb agreement, tense shifts, run-ons, dangling modifiers, wrong preposition/article.",
      "- Flag misspellings ONLY when the token is clearly wrong in the sentence's context. Consider the surrounding words and intended meaning before flagging.",
      "- DO NOT flag a word as misspelled if it is a valid English word used correctly in context (e.g. 'incase' as a preposition, 'biometric', 'technologic', 'assistance').",
      "- DO NOT flag British/American spelling variants (colour/color, artefact/artifact, organisation/organization).",
      "- DO NOT flag proper nouns: people's names (Mishra, Soman), place names, product/library names (Gantt, Kubernetes, MongoDB), acronyms.",
      "- DO NOT flag tokens that look like PDF text-extraction fragments (a partial word like 'gement', 'ertainty', 'nomy', 'syste', 'tem' that has no standalone meaning) — these are extraction artifacts, NOT author mistakes. CRITICAL: if a candidate misspelling looks like a complete word with extra letters trimmed (e.g. 'syste' from 'system', 'tem' from 'system', 'thent' from 'authentication'), it IS a fragment — skip it. Reviewers have explicitly called this out as the worst false-positive class.",
      "- DO NOT flag domain/technical jargon (HTTP verbs, framework names, algorithm names).",
      "- When flagging a real misspelling, quote the exact token from the report and suggest the correct word the sentence requires (not just dictionary nearest-neighbors).",
      "- Severity: MAJOR for typos that change/obscure meaning or appear in headings/abstracts; otherwise prefer fewer, higher-confidence findings over volume.",
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
    id: "passive-voice",
    name: "Passive voice",
    blurb: "Flag passive constructions where active voice improves clarity",
    defaultOn: true,
    instructions: [
      "Skill: PASSIVE VOICE.",
      "- Flag clauses that use passive voice where active voice would be clearer and the actor is known or obvious.",
      "- Quote the exact passive construction in `quotedText` (e.g. 'was implemented by the team', 'is being attended').",
      "- In `shortDescription`, ALWAYS include the literal phrase 'passive voice' (e.g. 'Passive voice — consider \"the team implemented\"'). The marking pipeline penalises deletions of issues whose description contains that phrase.",
      "- DO NOT flag passive voice in Methodology / Results / scientific-style sections where it is conventional and appropriate.",
      "- DO NOT flag passive constructions where the actor is genuinely unknown or irrelevant ('the file was corrupted', 'mistakes were made by an earlier process').",
      "- DO NOT flag stative `to be` + adjective ('is responsible', 'are visible') as passive — those are not passive voice.",
      "- Severity: MAJOR when passive obscures meaning or actor; otherwise prefer fewer, higher-confidence findings.",
      "- Category: SECTION_QUALITY.",
    ].join("\n"),
  },
  {
    id: "prose-quality",
    name: "Prose quality & depth",
    blurb: "Under-explained vs over-explained sections; vague filler",
    defaultOn: true,
    instructions: [
      "Skill: PROSE QUALITY & DEPTH (under/over-explained sections).",
      "- For each section, judge its depth against the TEMPLATE's guidance for that section's role.",
      "- Flag UNDER-EXPLAINED sections: shortDescription MUST start with the literal tag '[under]'. Cases: one-sentence stubs in sections requiring depth, claims with no rationale/example, missing required sub-discussion (e.g. Methodology lacking justification).",
      "- Flag OVER-EXPLAINED sections: shortDescription MUST start with '[over]'. Cases: padding / redundant repetition of earlier content, excessive background unrelated to the report's scope, vague filler ('various technologies', 'in today's world') stretched across paragraphs.",
      "- Quote the SECTION HEADING (preferred) or the first words of the offending paragraph in quotedText so the reviewer can navigate to it. Category: SECTION_QUALITY.",
      "- DO NOT suggest a rewrite. Depict the problem and locate it.",
      "- DO NOT flag stylistic preference (passive voice belongs to the passive-voice skill).",
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
  const base = enabledIds.length ? enabledIds : defaultSkillIds();
  // Always-on skills (e.g. flexible-section-matching) ride along on every
  // review, even when the report's stored enabledSkills predates them.
  const alwaysOn = SKILLS.filter((s) => s.alwaysOn).map((s) => s.id);
  const merged: string[] = [];
  for (const id of [...alwaysOn, ...base]) {
    if (!merged.includes(id)) merged.push(id);
  }
  const blocks = merged
    .map((id) => getSkill(id))
    .filter((s): s is SkillDef => !!s)
    .map((s) => s.instructions);
  if (!blocks.length) return "";
  return `Enabled review skills (focus your findings on these areas; ignore concerns outside them):\n\n${blocks.join("\n\n")}`;
}
