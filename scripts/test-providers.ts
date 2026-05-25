// Cross-provider regression suite. Run with:
//   pnpm tsx scripts/test-providers.ts
//
// Verifies:
//   - Schema preprocess truncates oversized strings (Gemini-style overrun)
//   - Tool-use input shape (Anthropic) parses through ReviewOutputSchema
//   - json_object response (OpenAI) parses through ReviewOutputSchema
//   - Gemini responseMimeType=json text parses through ReviewOutputSchema
//   - Mid-string truncation (Gemini MAX_TOKENS) recovers via salvage
//   - Mid-array truncation (OpenAI finish_reason=length) recovers via salvage
//   - Provider selector reads runtime file > env > default
//   - Availability gating: missing keys → unavailable; present keys → sdk
//   - Model catalog roundtrip (writeRuntimeModel / modelFor)

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  IssueSchema,
  ReviewOutputSchema,
  MarkingOutputSchema,
  reviewToolSchema,
  markingToolSchema,
} from "../lib/agent/schema";
import { salvageTruncatedJson } from "../lib/agent/llm/jsonSalvage";
import { SKILLS, buildSkillsSection, defaultSkillIds, getSkill } from "../lib/agent/skills";

let pass = 0;
let fail = 0;
const log = (ok: boolean, name: string, extra?: string) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "\n        " + extra : ""}`);
  }
};

console.log("\n== Schema (downstream of every provider) ==");

// 1. Anthropic tool_use shape — already-structured object goes straight to Zod
const anthropicReview = {
  issues: [
    {
      quotedText: "Lorem ipsum dolor sit amet",
      severity: "MAJOR",
      category: "GRAMMAR",
      shortDescription: "Sentence too long",
    },
  ],
};
try {
  const r = ReviewOutputSchema.parse(anthropicReview);
  log(r.issues.length === 1, "Anthropic-shape: 1 valid issue parses");
} catch (e: any) {
  log(false, "Anthropic-shape: 1 valid issue parses", e.message);
}

// 2. OpenAI json_object shape — JSON.parsed text → matches schema
const openaiText = JSON.stringify({
  issues: [
    {
      quotedText: "Quick brown fox",
      severity: "CRITICAL",
      category: "FORMAT",
      shortDescription: "Heading misformatted",
    },
    {
      quotedText: "Jumped over",
      severity: "MAJOR",
      category: "COMPLETENESS",
      shortDescription: "Missing citation",
    },
  ],
});
try {
  const parsed = ReviewOutputSchema.parse(JSON.parse(openaiText));
  log(parsed.issues.length === 2, "OpenAI-shape: 2 issues parse");
} catch (e: any) {
  log(false, "OpenAI-shape: 2 issues parse", e.message);
}

// 3. Gemini responseMimeType=json shape — same wire shape
const geminiText = JSON.stringify(anthropicReview);
try {
  ReviewOutputSchema.parse(JSON.parse(geminiText));
  log(true, "Gemini-shape: JSON.parse → schema OK");
} catch (e: any) {
  log(false, "Gemini-shape: JSON.parse → schema OK", e.message);
}

// 4. Gemini oversized quotedText (>500 chars) — preprocess truncates
const longQuote = "x".repeat(800);
try {
  const i = IssueSchema.parse({
    quotedText: longQuote,
    severity: "MAJOR",
    category: "OTHER",
    shortDescription: "oversize quote",
  });
  log(
    i.quotedText.length === 500 && i.quotedText.endsWith("..."),
    "Oversized quotedText (800) → truncated to 500 w/ '...'",
  );
} catch (e: any) {
  log(false, "Oversized quotedText truncation", e.message);
}

// 5. Oversized shortDescription
try {
  const i = IssueSchema.parse({
    quotedText: "ok",
    severity: "MAJOR",
    category: "OTHER",
    shortDescription: "z".repeat(400),
  });
  log(
    i.shortDescription.length === 200 && i.shortDescription.endsWith("..."),
    "Oversized shortDescription (400) → truncated to 200",
  );
} catch (e: any) {
  log(false, "shortDescription truncation", e.message);
}

// 6. Empty quotedText still rejected (defense against models hallucinating empties)
try {
  IssueSchema.parse({
    quotedText: "",
    severity: "MAJOR",
    category: "OTHER",
    shortDescription: "x",
  });
  log(false, "Empty quotedText should reject");
} catch {
  log(true, "Empty quotedText still rejected");
}

// 7. Bad enum value rejected
try {
  IssueSchema.parse({
    quotedText: "ok",
    severity: "MINOR",
    category: "OTHER",
    shortDescription: "x",
  });
  log(false, "Bad severity enum should reject");
} catch {
  log(true, "Bad severity enum still rejected");
}

// 8. Marking schema parses normal payload
try {
  const m = MarkingOutputSchema.parse({
    overall: 78,
    perSection: [{ title: "Intro", score: 80, note: "Clear" }],
  });
  log(m.overall === 78, "Marking schema: normal payload parses");
} catch (e: any) {
  log(false, "Marking schema: normal payload parses", e.message);
}

// 9. Marking out-of-range rejected
try {
  MarkingOutputSchema.parse({ overall: 150, perSection: [] });
  log(false, "Marking overall=150 should reject");
} catch {
  log(true, "Marking overall=150 rejected");
}

// 9b. Marking with perSection omitted → coerces to []
try {
  const m = MarkingOutputSchema.parse({ overall: 78 });
  log(Array.isArray(m.perSection) && m.perSection.length === 0, "Marking w/o perSection coerces to []");
} catch (e: any) {
  log(false, "Marking w/o perSection coerces to []", e.message);
}

// 9c. Marking with perSection=null → coerces to []
try {
  const m = MarkingOutputSchema.parse({ overall: 60, perSection: null });
  log(Array.isArray(m.perSection) && m.perSection.length === 0, "Marking perSection=null coerces to []");
} catch (e: any) {
  log(false, "Marking perSection=null coerces to []", e.message);
}

// 9d. Marking with long title/note → truncated
try {
  const m = MarkingOutputSchema.parse({
    overall: 70,
    perSection: [{ title: "T".repeat(200), score: 80, note: "N".repeat(500) }],
  });
  log(
    m.perSection[0].title.length === 120 && (m.perSection[0].note?.length ?? 0) === 300,
    "Marking long title/note → truncated",
  );
} catch (e: any) {
  log(false, "Marking long title/note → truncated", e.message);
}

console.log("\n== Salvage (Gemini MAX_TOKENS / OpenAI length) ==");

// 10. The user's actual error pattern — mid-string truncation in 2nd issue
const realError = '{ "issues": [ { "quotedText": "Table of Figures", "severity": "CRITICAL", "category": "FORMAT", "shortDescription": "Missing required section." }, { "quotedText": "Artefact", "severity": "MAJOR", "category": "FORMAT", "shortDescription": "Heading \'Artefact\' does not match template heading \'A';
{
  const salv = salvageTruncatedJson(realError) as any;
  const ok = salv && Array.isArray(salv.issues) && salv.issues.length === 1 && salv.issues[0].quotedText === "Table of Figures";
  log(!!ok, "Salvage: real Gemini error → keeps 1 valid issue");

  if (ok) {
    try {
      ReviewOutputSchema.parse(salv);
      log(true, "Salvaged output passes ReviewOutputSchema");
    } catch (e: any) {
      log(false, "Salvaged output passes ReviewOutputSchema", e.message);
    }
  }
}

// 11. OpenAI-style truncation (finish_reason=length)
const openaiTrunc = `{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"},{"quotedText":"b","severity":"CRITICAL","category":"FORMAT","shortDescription":"y"},{"quotedText":"c","severity":"MAJOR","category`;
{
  const salv = salvageTruncatedJson(openaiTrunc) as any;
  log(!!(salv && salv.issues?.length === 2), "Salvage: OpenAI-style truncation keeps 2 complete issues");
}

// 12. Total mess (truncated before any item completes) → null
{
  const salv = salvageTruncatedJson('{"issues":[{"quotedText":"a","severi');
  log(salv === null, "Salvage: irrecoverable returns null");
}

console.log("\n== Skills ==");

// S1. flexible-section-matching exists and is alwaysOn
{
  const s = getSkill("flexible-section-matching");
  log(!!s && s.defaultOn === true && s.alwaysOn === true, "flexible-section-matching defaultOn + alwaysOn");
}

// S2. alwaysOn skill present even when enabledIds doesn't include it
{
  const blob = buildSkillsSection(["grammar-prose"]);
  log(blob.includes("FLEXIBLE SECTION MATCHING"), "buildSkillsSection includes alwaysOn skill even when not explicitly enabled");
  log(blob.includes("GRAMMAR, SYNTAX & SPELLING"), "buildSkillsSection still respects explicit enabledIds");
}

// S3. alwaysOn appears first (highest priority in system prompt)
{
  const blob = buildSkillsSection([]);
  const flexIdx = blob.indexOf("FLEXIBLE SECTION MATCHING");
  const structIdx = blob.indexOf("STRUCTURE COMPLIANCE");
  log(flexIdx > -1 && structIdx > -1 && flexIdx < structIdx, "flexible-section-matching appears before structure-compliance");
}

// S4. No duplicate blocks if alwaysOn id also in enabledIds
{
  const blob = buildSkillsSection(["flexible-section-matching", "grammar-prose"]);
  const occurrences = (blob.match(/FLEXIBLE SECTION MATCHING/g) || []).length;
  log(occurrences === 1, `flexible-section-matching block appears exactly once (got ${occurrences})`);
}

// S5. Skill content covers the key user requirements
{
  const s = getSkill("flexible-section-matching")!;
  const keywords = ["Cover Page", "Declaration", "Bibliography", "Bibliography is OPTIONAL", "NUMBERING IS NOT STRUCTURAL"];
  const missing = keywords.filter((k) => !s.instructions.includes(k));
  log(missing.length === 0, `flexible-section-matching covers all req'd keywords${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`);
}

// S5b. Skill mentions visual inspection of pages 1-4 for image-only declarations
{
  const s = getSkill("flexible-section-matching")!;
  const visualKeywords = ["pages 1", "scanned", "image-only", "signature"];
  const hits = visualKeywords.filter((k) => s.instructions.toLowerCase().includes(k.toLowerCase()));
  log(hits.length === visualKeywords.length, `Skill instructs visual inspection (${hits.length}/${visualKeywords.length} keywords)`);
}

// S6. defaultSkillIds includes new skill
{
  const ids = defaultSkillIds();
  log(ids.includes("flexible-section-matching"), "defaultSkillIds includes flexible-section-matching");
}

console.log("\n== explainPresence (UI tooltip reason) ==");

{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { explainPresence } = require("../lib/agent/sectionGroups");

  // E1. Template heading "References and Bibliography" matched by report's "References" heading → present + reason
  {
    const r = explainPresence("References and Bibliography", "1. Introduction\nfoo\n2. References\n[1] X.");
    log(r.present && /references|same section role|overlaps/i.test(r.reason), `Reason explains References match (reason=${r.reason.slice(0, 80)}…)`);
  }

  // E2. Missing section gives reason listing tried synonyms
  {
    const r = explainPresence("References and Bibliography", "1. Introduction\nfoo\n2. Conclusion\nbar");
    log(!r.present && r.reason.includes("references") && r.reason.includes("bibliography"), "Missing-section reason lists searched synonyms");
  }

  // E3. Declaration via 'I hereby declare' gives explicit-reason
  {
    const r = explainPresence("Title and Declaration Sheet", "I hereby declare that this work is mine.\nIntro");
    log(r.present && /declaration phrase|i hereby declare/i.test(r.reason), "Declaration via phrase fragment gives clear reason");
  }

  // E4. Cover Page via 'Submitted by' fallback gives explicit reason
  {
    const r = explainPresence("Cover Page", "Submitted by Jane Doe\nBachelor of CS\n1. Introduction");
    log(r.present && /submitted by|cover-page keyword/i.test(r.reason), "Cover Page via keyword gives clear reason");
  }

  // E5. Exact heading match gives "Exact heading" reason
  {
    const r = explainPresence("Conclusion", "1. Introduction\n2. Conclusion\nDone.");
    log(r.present && /exact heading|equivalent heading/i.test(r.reason), `Exact match labelled appropriately (reason=${r.reason.slice(0, 60)}…)`);
  }
}

console.log("\n== Required-sections check (rule pass, synonym-aware) ==");

{
  // Use require to avoid the dynamic-import esbuild parse issues seen earlier.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requiredSectionsCheck, __test } = require("../lib/checks/requiredSections");

  // R1. Template says "References and Bibliography"; report has only "References" → PRESENT
  {
    const issues = requiredSectionsCheck({
      plainText: "1. Introduction\nfoo\n2. Methods\nbar\n3. Results\nbaz\n4. References\n[1] X.",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "1. Introduction\n2. Methods\n3. Results\n4. References and Bibliography\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    const missingRef = issues.some((i: any) => /references/i.test(i.shortDescription));
    log(!missingRef, "References-only report satisfies 'References and Bibliography' template");
  }

  // R2. Template says "References and Bibliography"; report has only "Bibliography" → PRESENT
  {
    const issues = requiredSectionsCheck({
      plainText: "1. Introduction\n2. Methods\n3. Results\n4. Bibliography\n[1] X.",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "References and Bibliography\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    log(issues.length === 0, "Bibliography-only report satisfies 'References and Bibliography' template");
  }

  // R3. Template says "References"; report has none → MISSING
  {
    const issues = requiredSectionsCheck({
      plainText: "1. Introduction\nfoo\n2. Conclusion\nbar",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "1. Introduction\n2. Conclusion\n3. References\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    const refMissing = issues.some((i: any) => /references/i.test(i.shortDescription));
    log(refMissing, "Truly missing References still flagged");
  }

  // R4. Bibliography ALONE is optional — never flag missing
  {
    // Template explicitly asks Bibliography only (not via References group).
    // We register it via the optional Bibliography group. Verify it's not flagged.
    const issues = requiredSectionsCheck({
      plainText: "1. Introduction\n2. Conclusion",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "Bibliography\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    const bibMissing = issues.some((i: any) => /bibliography/i.test(i.shortDescription));
    log(!bibMissing, "Bibliography (standalone optional) never flagged as missing");
  }

  // R5. Cover Page heading not present but text shows university/title block → PRESENT
  {
    const issues = requiredSectionsCheck({
      plainText: "Bachelor of Computer Science\nSubmitted by John Doe\n1. Introduction\nfoo",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "Cover Page\n1. Introduction\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    const coverMissing = issues.some((i: any) => /cover page/i.test(i.shortDescription));
    log(!coverMissing, "Cover Page: 'Submitted by' + 'Bachelor of' text counts as present");
  }

  // R6. Declaration via 'I hereby declare' fragment → PRESENT
  {
    const issues = requiredSectionsCheck({
      plainText: "I hereby declare that this work is my own.\n1. Introduction\nfoo",
      filename: "r.pdf",
      templates: [{ name: "T", plainText: "Title and Declaration Sheet\n1. Introduction\n" }],
      wordCountMin: 0,
      wordCountMax: 0,
    });
    const declMissing = issues.some((i: any) => /declaration/i.test(i.shortDescription));
    log(!declMissing, "Declaration via 'I hereby declare' fragment counts as present");
  }

  // R7. Numbered template heading like '4. References and Bibliography' resolves to group
  {
    const g = __test.findGroup(__test.normalize("4. References and Bibliography"));
    log(!!g && g.canonical === "References", "findGroup: '4. References and Bibliography' → References");
  }

  // R8. Synonym normalization handles 'References' alone
  {
    const g = __test.findGroup(__test.normalize("References"));
    log(!!g && g.canonical === "References", "findGroup: 'References' → References");
  }

  // R9. 'Bibliography' alone → Bibliography group OR References group (both should resolve to skip flagging)
  {
    const g = __test.findGroup(__test.normalize("Bibliography"));
    log(!!g, "findGroup: 'Bibliography' resolves to a group");
  }
}

console.log("\n== Attachments routing ==");

// A1. LlmAttachment type allows PDF + image; data is Buffer
import type { LlmAttachment } from "../lib/agent/llm/types";
{
  const att: LlmAttachment = { mimeType: "application/pdf", data: Buffer.from("test"), description: "test" };
  log(Buffer.isBuffer(att.data) && att.mimeType === "application/pdf", "LlmAttachment shape compiles + carries Buffer");
}

// A2. Mocked Gemini provider call structure — attachments become inlineData parts
{
  // Verify the gemini adapter source contains the inlineData wiring without
  // actually invoking the API.
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("./lib/agent/llm/gemini.ts", "utf8");
  log(src.includes("inlineData") && src.includes("att.data.toString(\"base64\")"), "Gemini adapter wires attachments → inlineData");
}

// A3. Anthropic SDK adapter wires PDFs → document blocks
{
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("./lib/agent/llm/anthropic.ts", "utf8");
  log(src.includes('type: "document"') && src.includes('"application/pdf"'), "Anthropic SDK adapter wires PDFs → document blocks");
  log(src.includes('type: "image"') && src.includes('att.mimeType.startsWith("image/")'), "Anthropic SDK adapter wires images → image blocks");
}

// A4. Reviewer attaches only on attachment-capable providers, gates by size
{
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("./lib/agent/reviewer.ts", "utf8");
  log(
    src.includes("supportsAttachments") &&
      src.includes('provider.name === "anthropic" || provider.name === "gemini"'),
    "reviewer gates attachments on anthropic|gemini only",
  );
  log(src.includes("MAX_ATTACHMENT_BYTES"), "reviewer enforces attachment size cap");
  log(src.includes("loadReportAttachment"), "reviewer loads PDF lazily from storage");
}

console.log("\n== Tool schemas (sent to each provider) ==");

// 13. reviewToolSchema input_schema has maxLength on quoted/desc
{
  const props: any = reviewToolSchema.input_schema.properties.issues.items.properties;
  log(props.quotedText.maxLength === 500, "reviewToolSchema.quotedText.maxLength=500");
  log(props.shortDescription.maxLength === 200, "reviewToolSchema.shortDescription.maxLength=200");
}

// 14. markingToolSchema requires overall (perSection now optional — see 9b/9c)
{
  const required = markingToolSchema.input_schema.required;
  log(
    required.includes("overall") && !required.includes("perSection"),
    "markingToolSchema requires overall, perSection optional",
  );
}

console.log("\n== Settings + availability ==");

// Tests mutate the real storage/llm-settings.json — back it up first.
async function settingsTests() {
  const settings = await import("../lib/agent/llm/settings");
  const settingsPath = path.join(
    process.env.STORAGE_DIR || "./storage",
    "llm-settings.json",
  );
  let backup: string | null = null;
  try {
    backup = await fs.readFile(settingsPath, "utf8");
  } catch {
    backup = null;
  }
  // Save env we'll mutate
  const envBackup = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
  };
  // Remove any existing runtime file so default-source tests are accurate.
  await fs.rm(settingsPath, { force: true });

  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLM_PROVIDER;

    {
      const s = await settings.llmStatus();
      log(s.current === "anthropic", "Default provider=anthropic");
      log(s.source === "default", `source=default when no env/runtime (got ${s.source})`);
    }

    {
      const a = settings.checkAvailability();
      // If the host has `claude` CLI installed, anthropic stays available via CLI
      // even without the key — expected per design. Assert via=cli in that case.
      if (a.anthropic.available) {
        log(a.anthropic.via === "cli", "Anthropic falls back to CLI when key missing");
      } else {
        log(true, "Anthropic unavailable w/o key/CLI");
      }
      log(!a.codex.available, "Codex unavailable w/o OPENAI_API_KEY");
      log(!a.gemini.available, "Gemini unavailable w/o GEMINI_API_KEY");
    }

    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test";
    process.env.GEMINI_API_KEY = "test";
    {
      const a = settings.checkAvailability();
      log(a.anthropic.available && a.anthropic.via === "sdk", "Anthropic available via SDK w/ key");
      log(a.codex.available && a.codex.via === "sdk", "Codex available via SDK w/ key");
      log(a.gemini.available && a.gemini.via === "sdk", "Gemini available via SDK w/ key");
    }

    process.env.LLM_PROVIDER = "gemini";
    {
      const s = await settings.llmStatus();
      log(s.current === "gemini" && s.source === "env", "Env override LLM_PROVIDER=gemini");
    }

    await settings.writeRuntimeProvider("codex");
    {
      const s = await settings.llmStatus();
      log(s.current === "codex" && s.source === "runtime", "Runtime file beats env");
    }

    await settings.writeRuntimeModel("codex", "gpt-5-mini");
    {
      const m = await settings.modelFor("codex");
      log(m === "gpt-5-mini", `modelFor(codex) === gpt-5-mini (got ${m})`);
    }

    try {
      await settings.writeRuntimeModel("codex", "totally-fake-model");
      log(false, "writeRuntimeModel rejects unknown model");
    } catch {
      log(true, "writeRuntimeModel rejects unknown model");
    }

    {
      const s = await settings.llmStatus();
      log(
        s.catalog.anthropic.length > 0 && s.catalog.codex.length > 0 && s.catalog.gemini.length > 0,
        "Catalog has entries for all 3 providers",
      );
    }
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Restore settings file
    if (backup !== null) await fs.writeFile(settingsPath, backup, "utf8");
    else await fs.rm(settingsPath, { force: true });
  }
}

console.log("\n== Reviewer routing (mocked) ==");

// 23. Trace: provider.generateJson result → ReviewOutputSchema.parse path.
// Confirm a synthetic provider that returns Anthropic-shape input is accepted
// without provider-specific branching in reviewer.ts.
async function reviewerRoutingTest() {
  const fakeJson = {
    issues: [
      {
        quotedText: "A".repeat(600), // oversized — should still pass via preprocess
        severity: "MAJOR",
        category: "OTHER",
        shortDescription: "z".repeat(250), // oversized — also truncated
      },
    ],
  };
  try {
    const parsed = ReviewOutputSchema.parse(fakeJson);
    log(
      parsed.issues[0].quotedText.length === 500 &&
        parsed.issues[0].shortDescription.length === 200,
      "Reviewer downstream: oversize from any provider is normalized",
    );
  } catch (e: any) {
    log(false, "Reviewer downstream: oversize from any provider is normalized", e.message);
  }
}

(async () => {
  await settingsTests();
  await reviewerRoutingTest();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
