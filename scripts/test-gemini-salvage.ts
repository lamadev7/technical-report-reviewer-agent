// Smoke test for the Gemini JSON salvage logic. Run with:
//   pnpm tsx scripts/test-gemini-salvage.ts

import { salvageTruncatedJson } from "../lib/agent/llm/jsonSalvage";

interface Case {
  name: string;
  input: string;
  expectShape: "object" | "null";
  check?: (parsed: any) => boolean;
}

const cases: Case[] = [
  {
    name: "complete JSON parses normally (control)",
    input: '{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"}]}',
    expectShape: "object",
    check: (p) => p.issues.length === 1,
  },
  {
    name: "truncated mid-string in 2nd issue → keeps 1st",
    input:
      '{ "issues": [ { "quotedText": "Table of Figures", "severity": "CRITICAL", "category": "FORMAT", "shortDescription": "Missing required section." }, { "quotedText": "Artefact", "severity": "MAJOR", "category": "FORMAT", "shortDescription": "Heading \'Artefact\' does not match template heading \'A',
    expectShape: "object",
    check: (p) => Array.isArray(p.issues) && p.issues.length === 1 && p.issues[0].quotedText === "Table of Figures",
  },
  {
    name: "truncated between items (comma cleanup)",
    input:
      '{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"},{"quotedText":"b","severity":"CRITICAL","category":"FORMAT","shortDescription":"y"},',
    expectShape: "object",
    check: (p) => p.issues.length === 2,
  },
  {
    name: "truncated mid 2nd issue (incomplete object)",
    input:
      '{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"},{"quotedText":"b","severity":"CRIT',
    expectShape: "object",
    check: (p) => p.issues.length === 1 && p.issues[0].quotedText === "a",
  },
  {
    name: "single complete issue, no trailing comma",
    input:
      '{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"}]}',
    expectShape: "object",
    check: (p) => p.issues.length === 1,
  },
  {
    name: "truncated before any issue completes → null (unrecoverable)",
    input: '{"issues":[{"quotedText":"a","severity":"MAJ',
    expectShape: "null",
  },
  {
    name: "fenced JSON with cutoff inside fence",
    input: '```json\n{"issues":[{"quotedText":"a","severity":"MAJOR","category":"GRAMMAR","shortDescription":"x"},{"qu',
    expectShape: "object",
    check: (p) => p.issues.length === 1,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = salvageTruncatedJson(c.input);
  const shape = got === null ? "null" : typeof got === "object" ? "object" : "scalar";
  const ok = shape === c.expectShape && (!c.check || (got !== null && c.check(got)));
  if (ok) {
    pass++;
    console.log(`  PASS  ${c.name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${c.name}`);
    console.log("        expectShape:", c.expectShape, "got shape:", shape);
    console.log("        result:", JSON.stringify(got));
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
