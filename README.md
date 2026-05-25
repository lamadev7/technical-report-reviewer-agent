# Report Reviewer Agent

AI-assisted student report reviewer. Reviewer uploads templates + good/bad samples, drops in student reports, the agent flags **critical** and **major** issues with hover popovers on the formatted document, reviewer edits/approves comments, then emails feedback (with screenshots) to the student.
<img width="1512" height="824" alt="Screenshot 2026-05-24 at 11 28 58" src="https://github.com/user-attachments/assets/3c0fa5f7-dc77-420d-b9b7-18f896f840e9" />

## Stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router) + React 19 + Tailwind 4 + TypeScript |
| LLM (pluggable) | **Anthropic Claude** (SDK or `claude` CLI) · **OpenAI Codex/GPT-5** (SDK) · **Google Gemini** (SDK) — switchable from the UI |
| Default models | `claude-sonnet-4-6` · `gpt-5-codex` · `gemini-2.5-flash` |
| Multi-modal | PDF + image attachments routed to Anthropic SDK + Gemini; agent SEES scanned declaration sheets, logos, signatures |
| DB | Postgres (Prisma 6) |
| Blob | Local filesystem (`./storage/`) — abstracted in `lib/storage.ts` |
| Email | Gmail SMTP via `nodemailer` (inline CID PNG screenshots) |
| PDF ingest (server) | `pdf2json` — pure-JS, no worker spawn |
| PDF render (client) | `react-pdf` + `pdfjs-dist` text layer |
| DOCX → HTML | `mammoth` (legacy reports only) |
| `.doc` | `libreoffice --headless` → DOCX → mammoth (legacy reports only) |
| Screenshots | Playwright headless Chromium |
| Streaming | Server-Sent Events (`/review/stream`) + DB-backed `reviewProgress` |

## Setup

```bash
nvm use                          # picks Node 20.20.2 from .nvmrc
pnpm install
pnpm exec playwright install chromium   # download browser for screenshots
cp .env.example .env             # fill in keys (see below)
pnpm exec prisma migrate deploy
pnpm dev
```

Minimum required env: `DATABASE_URL` + **one** of (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`) OR the `claude` CLI installed and logged in.

System deps:
- Postgres running locally (or change `DATABASE_URL`)
- `libreoffice` on PATH for `.doc` ingest (`brew install --cask libreoffice` on macOS). PDF + DOCX work without it.

## Env vars

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `LLM_PROVIDER` | `anthropic` (default) / `codex` / `gemini`. Seed value — runtime UI switch persists in `storage/llm-settings.json` and takes precedence. |
| `ANTHROPIC_API_KEY` | If set → SDK. If empty/unset → `claude` CLI fallback (run `claude /login` once first). |
| `ANTHROPIC_MODEL` | Override default `claude-sonnet-4-6`. |
| `OPENAI_API_KEY` | Required for `codex` provider. |
| `OPENAI_MODEL` | Override default `gpt-5-codex`. |
| `GEMINI_API_KEY` | Required for `gemini` provider. |
| `GEMINI_MODEL` | Override default `gemini-2.5-flash`. |
| `GMAIL_USER` | Gmail address used to send feedback emails. |
| `GMAIL_APP_PASSWORD` | App password (generate at https://myaccount.google.com/apppasswords). |
| `STORAGE_DIR` | Defaults to `./storage`. |
| `APP_URL` | Defaults to `http://localhost:3000`. |

## User flow

1. `/knowledge` — upload at least one **template**, optionally **excellent** and **bad** samples.
2. `/` — drop a student report (`.pdf` only — preserves formatting), pick **Review mode** and **Marking mode**, upload.
3. `/report/[id]` opens. Click **Review** — agent flags critical/major issues + computes marking.
4. Hover any highlight in the document for issue details. Right panel: edit comment text/severity/category, delete, or select text and **+Add** a manual comment.
5. **Approve** → enables **Send feedback to <email>** (only visible if report header had a student email).
6. Email goes via Gmail SMTP with one PNG screenshot per issue inline; marking is **never** included in the email.

Bottom-left of the sidebar carries the **provider badge** — click it to switch provider or change the per-provider model. Unavailable providers (missing key) are greyed out with a reason in the tooltip.

## Highlight colors

| Severity | Color | Notes |
|---|---|---|
| CRITICAL | red | template/section/grammar that blocks meaning |
| MAJOR | orange | significant but non-blocking |
| MINOR | — | never highlighted (spec) |

## Architecture

### High-level

```
                     ┌──────────────────────────────────────────────────────┐
                     │  Next.js 16 App Router (single process, nodejs runtime) │
                     └──────────────────────────────────────────────────────┘
                                          │
   Browser ◄──── React 19 / Tailwind ─────┤
   (PDF.js,                               │
    SSE client,                           ▼
    provider badge)               ┌───────────────┐
                                  │  Route handlers│
                                  │  /api/reports  │
                                  │  /api/knowledge│
                                  │  /api/llm      │ ── provider/model switch
                                  │  /review/stream│ ── SSE ──► Browser
                                  └───────┬────────┘
                                          │
                ┌─────────────────────────┼────────────────────────────────┐
                │                         │                                │
                ▼                         ▼                                ▼
        ┌──────────────┐         ┌──────────────────┐            ┌────────────────┐
        │ Postgres     │         │ lib/agent        │            │ lib/checks     │
        │ (Prisma)     │◄────────┤  reviewer.ts     │            │  deterministic │
        │  Report      │         │  marking.ts      │            │  preflight     │
        │  Issue       │         │  markingScheme   │            │  (wordCount,   │
        │  KbTemplate  │         │  skills / prompts│            │   requiredSec, │
        │  KbSample    │         │  sectionGroups   │◄───────────┤   depth)       │
        │  LearnedRej. │         │  learning        │            └────────────────┘
        └──────────────┘         └────────┬─────────┘
                                          │
                                          ▼
                        ┌───────────────────────────────────────────┐
                        │  lib/agent/llm — provider abstraction     │
                        │  ┌──────────────┐ ┌────────┐ ┌──────────┐ │
                        │  │ anthropic.ts │ │codex.ts│ │gemini.ts │ │
                        │  │ SDK + CLI    │ │OpenAI  │ │@google/  │ │
                        │  │ (PDF / image)│ │SDK     │ │genai     │ │
                        │  └──────────────┘ └────────┘ │(PDF / img│ │
                        │                              │  inline) │ │
                        │  settings.ts (runtime file + env)        │
                        │  jsonSalvage.ts (MAX_TOKENS recovery)    │
                        └───────────────────────────────────────────┘

  Side effects:
    storage/   (local FS via lib/storage.ts — uploaded PDFs, screenshots,
                llm-settings.json runtime provider/model selection)
    Playwright (headless Chromium → PNG of highlight context for email)
    nodemailer (Gmail SMTP → student email with inline CID images)
```

### Layers

| Layer | What lives here | Files |
|---|---|---|
| UI | Server + client React components, PDF viewer with custom text-layer highlight, SSE subscription, optimistic state, provider/model switcher in sidebar badge | `components/`, `app/` |
| HTTP | Next.js Route Handlers (REST + SSE). Thin glue: validate → call lib → respond. Long jobs use `after()` to detach. | `app/api/**/route.ts` |
| Agent | Prompt assembly, tool-use schemas, provider abstraction, progress ticker, dismissal de-dupe, fallback marking, cross-report learning, shared section-equivalence | `lib/agent/` |
| LLM | Provider-agnostic interface (`generateJson({systemSegments, userSegments, attachments, schema})`). One adapter per provider; runtime selection from env + `storage/llm-settings.json`. JSON salvage on MAX_TOKENS. | `lib/agent/llm/` |
| Checks | Cheap deterministic rules run **before** the LLM: word count, required sections (synonym-aware), section-depth heuristic. Pure `(CheckContext) → RuleIssue[]`. | `lib/checks/` |
| Ingest | File → `{ html, plainText }`. PDF via `pdf2json` (no worker), DOCX via `mammoth`, `.doc` via `libreoffice` shell-out. Header regex pulls student name + email. | `lib/ingest/` |
| Output | PDF export, Playwright PNG screenshot per issue for the email body. | `lib/pdf/` |
| Email | Gmail SMTP via nodemailer; inline `cid:` PNGs; CRITICAL-only filter; marking deliberately stripped. | `lib/email/` |
| Storage | Filesystem-backed `save(bucket, name, buf)` returning a relative path; designed to swap to S3/GCS by replacing one module. | `lib/storage.ts` |
| DB | Postgres + Prisma. JSON columns for `marking`, `reviewProgress`, `markingScheme` — schemaless tail of evolving agent output. | `prisma/schema.prisma` |

### Data model

```
KbTemplate  1───*  Report  1───*  Issue
                    │
                    ├── templateId   ── soft FK to the pinned scheme
                    ├── marking      JSON (overall, perSection, baselines, passive penalties)
                    ├── reviewProgress JSON (stage, steps[], counts, error)
                    ├── enabledSkills String[]  (subset of SKILLS by id)
                    ├── wordCountMin Int @default(8000)
                    └── wordCountMax Int @default(12000)

KbSample (EXCELLENT|BAD)     → calibration corpus, shared across reports
LearnedRejection             → cross-report dismissal hits (normalizedDesc → hitCount)
```

Key fields worth noting:
- `Issue.deleted` is a **soft delete**. Dismissed issues are kept so the next review pass can suppress near-duplicates and feed the cross-report `LearnedRejection` counter.
- `Report.marking.baselineOverall` + `baselinePenalty` snapshot what the agent scored on the last full run so per-issue edits can move the score *relative* to that baseline (`recomputeMarking` in `lib/agent/marking.ts`) without re-paying for an LLM call.
- `Report.reviewProgress.steps[]` is the preflight checklist rendered in the right sidebar. The reviewer route writes it, and `mergePreflightSteps` re-attaches it to every subsequent stage update so refreshes don't wipe the list.

## LLM provider abstraction

Single interface (`lib/agent/llm/types.ts`):

```ts
interface LlmJsonRequest {
  systemSegments: LlmSegment[];   // cache hints honored by Anthropic
  userSegments: LlmSegment[];
  attachments?: LlmAttachment[];  // PDFs / images for multimodal providers
  schemaName?: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface LlmProvider {
  name: "anthropic" | "codex" | "gemini";
  generateJson(req: LlmJsonRequest): Promise<{ json: unknown; via: string }>;
}
```

`reviewer.ts` calls `getProvider().generateJson(...)`. Provider selection: `storage/llm-settings.json` (UI-set) > `LLM_PROVIDER` env > default `anthropic`. Per-provider model override stored the same way.

### Provider matrix

| Provider | Auth | Structured output | Multi-modal | Caching |
|---|---|---|---|---|
| **Anthropic SDK** | `ANTHROPIC_API_KEY` | `tool_use` w/ forced tool name | PDF (`document` blocks) + images | `cache_control: ephemeral` on segments tagged `cache: true` |
| **Anthropic CLI** | `claude /login` once | `--output-format json` (text JSON, schema validated downstream) | — (text only) | — |
| **OpenAI Codex** | `OPENAI_API_KEY` | `response_format: json_object`; uses `max_completion_tokens` + `reasoning_effort: "low"` for gpt-5/o-series | — (silently skips; reviewer prompt notes attachment unavailable) | — |
| **Google Gemini** | `GEMINI_API_KEY` | `responseMimeType: application/json` + `responseSchema` (OpenAPI subset) | PDFs + images via `inlineData` parts | — |

### Truncation handling (Gemini, OpenAI)

Gemini 2.5 Flash burns output budget on internal "thinking" tokens; OpenAI gpt-5/o-series do the same on reasoning. When `finishReason === "MAX_TOKENS"` (Gemini) or `finish_reason === "length"` (OpenAI), `lib/agent/llm/jsonSalvage.ts` walks the partial JSON, truncates at the last safe element boundary, and closes open brackets — returning whatever issues fully completed instead of failing the whole review. Gemini Flash thinking budget is set to `0`; Gemini Pro to `256` (minimum it accepts).

## Multi-modal review

When the active provider supports it (`anthropic` SDK or `gemini`), `reviewer.ts` loads the original report PDF and attaches it to the review call as an `LlmAttachment`. The agent SEES the rendered pages — meaning:

- **Cover pages** with university logos, embedded title blocks, and "Submitted by …" lines count as present even when text extraction returns nothing for that page.
- **Declaration sheets** inserted as scanned/photographed pages between page 1 and page 4 count as present without needing a literal "Declaration" heading.
- **Signed signature blocks**, stamps, and rendered text-as-image are visually verified.

Cap: 18 MB. Above that, the attachment is skipped and the prompt notes the agent is text-only — biasing toward "present" to avoid false-positive structural flags. The marking call stays text-only (cost optimization).

## Section equivalence (single source of truth)

`lib/agent/sectionGroups.ts` defines equivalence groups consumed by three layers:

1. `lib/checks/requiredSections.ts` — deterministic pre-flight rule check
2. `components/ReportViewer.tsx` — marking-scheme modal tooltips (hover the cross/check icon to see WHY a section was matched or marked missing, with the exact synonym list searched)
3. `lib/agent/skills.ts:flexible-section-matching` — mirrored in natural language for the LLM prompt

Examples of what counts as the same section:
- `References` ≡ `Bibliography` ≡ `Works Cited` ≡ `References and Bibliography` (Bibliography alone is optional)
- `Title and Declaration Sheet` ≡ `Declaration` ≡ `Statement of Originality` ≡ any block containing `I hereby declare`
- `Cover Page` ≡ a first-page block with `Submitted by` / `Bachelor of` / university name (text or image)
- `Methodology` ≡ `Methods` ≡ `Approach` ≡ `Research Method`
- … 20 groups total. Add a new equivalence by editing one file.

Numbering schemes (`1.2.3` vs `II.B.1` vs `Chapter 4 —`) are **never** compared between template and report — only role.

## Skills system

Skills are review directives injected into the system prompt. `enabledSkills: string[]` on the Report turns each on/off per report. Notable:

- `flexible-section-matching` — **`alwaysOn`**: rides along on every review regardless of the report's stored `enabledSkills`. Tells the agent to match by role, ignore numbering, and inspect attached PDF pages 1–4 for image-only declarations before flagging missing.
- `structure-compliance` — defers to flexible-section-matching for naming/numbering; only flags genuinely missing sections.
- `format-style`, `grammar-prose`, `section-depth`, `passive-voice`, `prose-quality`, `originality`, `reference-quality`, `factual-plausibility`, `literature-review`, `technical-diagrams`.

Catalog lives in `lib/agent/skills.ts`. `SkillDef.alwaysOn` is the mechanism for structural rules that must never be disabled.

## Learning loop

```
reviewer deletes an issue
        │
        ▼
PATCH/DELETE /issues/[iid] → soft-delete (deleted=true) + upsert LearnedRejection
        │
        ▼
next review:
  • Per-report:   dismissedBlob lists every soft-deleted issue's quotedText
                  + description → injected into the user prompt
  • Cross-report: LearnedRejection.hitCount >= LEARNED_REJECTION_THRESHOLD
                  → injected as a global "don't flag X" hint
        │
        ▼
isDismissedDuplicate() also filters anything the agent re-surfaces
post-tool-call (belt + braces)
```

Result: the same false positive never has to be deleted twice on the same report, and patterns dismissed repeatedly across many reports become global "do not flag" rules — without retraining or fine-tuning.

## Marking scheme

Generated once per template (and on demand when missing) by parsing top-level numbered headings (`extractTopics` in `lib/agent/markingScheme.ts`). Encodes:
- `totalPoints` budget (100)
- `topics[]` — heading, weight, required-flag
- `wordCountBand` — min/max (default 8000–12000)
- `penalties` — per-category deduction weights used by the deterministic recompute

When the LLM marking call fails, the same scheme drives the fallback score, so the system **degrades gracefully** rather than going blank. The marking schema's `perSection` is also tolerant: a model returning just `{overall: 78}` is coerced to `{overall: 78, perSection: []}` rather than triggering a re-attempt.

## Output schemas

`lib/agent/schema.ts`:
- `ReviewOutputSchema.issues[]`: `quotedText` (max 500, auto-truncated with `…` on overrun), `severity`, `category`, `shortDescription` (max 200, auto-truncated).
- `MarkingOutputSchema`: `overall` 0–100 (required), `perSection[]` (optional — coerced to `[]` when missing/null).

The same JSON Schema is sent to every provider (`reviewToolSchema.input_schema`, `markingToolSchema.input_schema`) with `maxLength`/`maxItems` so providers that respect schema constraints (Gemini's `responseSchema`) enforce them server-side.

## Concurrency + lifetime

- One review at a time per report — enforced by checking `status === "REVIEWING"` at the route handler and by the per-report `AbortController`.
- Heartbeat ticker every 4s while the agent runs so SSE subscribers and the elapsed-seconds counter on the UI stay live during a multi-minute LLM call.
- `maxDuration = 600` on the review route — fits on Vercel hobby and large local jobs.
- `globalThis`-keyed Maps for SSE subscribers + abort controllers survive HMR in dev; in prod they live for the process lifetime.

## Trust + safety boundaries

- Email sending requires `report.status ∈ {APPROVED, SENT}` AND a syntactically valid student email saved on the report.
- `marking` is **never** included in the email — the perSection scores stay reviewer-internal.
- Screenshots are rendered from `plainText` (server-controlled context window around the quoted span), not the raw uploaded file — no third-party JS executes during the screenshot.
- File uploads are restricted to `.pdf` (preserves formatting, lowest extraction-edge risk). DOCX/`.doc` ingest paths remain in `lib/ingest/toHtml.ts` for legacy reports already in the DB but are not user-facing at the upload endpoint.
- The provider switcher rejects switches to a provider whose key/CLI is missing (HTTP 409) — UI greys the option and shows the reason on hover.

## Testing

Regression suite covers every layer:

```bash
npx tsx scripts/test-providers.ts        # 60+ assertions: schema, salvage, skills,
                                         # section equivalence, attachments routing,
                                         # settings + availability, marking shape
npx tsx scripts/test-gemini-salvage.ts   # 7 cases for the JSON-truncation salvage
```

Both run without network calls — providers are tested via static source assertions + schema/parser checks.

## Out of scope (MVP)

- Multi-reviewer accounts / auth
- Cloud blob storage (filesystem abstracted for swap)
- Background job queue (review runs inline via `after()`; `maxDuration` set to 600s)
- Showing marking to the student
- OpenAI multi-modal (PDF) — Chat Completions doesn't accept PDFs directly; would need migration to Responses API or Files API
