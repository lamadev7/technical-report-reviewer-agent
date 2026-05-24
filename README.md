# Report Reviewer Agent

AI-assisted student report reviewer. Reviewer uploads templates + good/bad samples, drops in student reports, Claude flags **critical** and **major** issues with hover popovers on the formatted document, reviewer edits/approves comments, then emails feedback (with screenshots) to the student.
<img width="1512" height="824" alt="Screenshot 2026-05-24 at 11 28 58" src="https://github.com/user-attachments/assets/3c0fa5f7-dc77-420d-b9b7-18f896f840e9" />

## Stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router) + React 19 + Tailwind 4 + TypeScript |
| LLM | Anthropic Claude Sonnet 4.6 (`claude-sonnet-4-6`) via tool-use |
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
cp .env.example .env             # set DATABASE_URL, ANTHROPIC_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD
pnpm exec prisma migrate dev --name init
pnpm dev
```

System deps:
- Postgres running locally (or change `DATABASE_URL`)
- `libreoffice` on PATH for `.doc` ingest (`brew install --cask libreoffice` on macOS). PDF + DOCX work without it.

## Env vars

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `ANTHROPIC_API_KEY` | If set → SDK path. If empty/unset → falls back to `claude` CLI (run `claude /login` once first). |
| `GMAIL_USER` | Gmail address used to send feedback emails |
| `GMAIL_APP_PASSWORD` | App password (generate at https://myaccount.google.com/apppasswords) |
| `STORAGE_DIR` | Defaults to `./storage` |
| `APP_URL` | Defaults to `http://localhost:3000` |

## User flow

1. `/knowledge` — upload at least one **template**, optionally **excellent** and **bad** samples.
2. `/` — drop a student report (`.pdf` only — preserves formatting), pick **Review mode** and **Marking mode**, upload.
3. `/report/[id]` opens. Click **Review** — agent flags critical/major issues + computes marking.
4. Hover any highlight in the document for issue details. Right panel: edit comment text/severity/category, delete, or select text and **+Add** a manual comment.
5. **Approve** → enables **Send feedback to <email>** (only visible if report header had a student email).
6. Email goes via Gmail SMTP with one PNG screenshot per issue inline; marking is **never** included in the email.

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
    EventSource)                  ┌───────────────┐
                                  │  Route handlers│
                                  │  /api/reports  │
                                  │  /api/knowledge│
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
        │  KbTemplate  │         │  skills / prompts│            │   sections,    │
        │  KbSample    │         │  learning        │            │   depth)       │
        │  LearnedRej. │         └────────┬─────────┘            └────────────────┘
        └──────────────┘                  │
                                          │ tool-use / JSON-schema
                                          ▼
                          ┌────────────────────────────────────┐
                          │  Anthropic Claude (Sonnet 4.6)     │
                          │  • SDK path: tool-use + cache      │
                          │  • CLI fallback: claude -p --json  │
                          └────────────────────────────────────┘

  Side effects:
    storage/   (local FS via lib/storage.ts — uploaded PDFs, screenshots)
    Playwright (headless Chromium → PNG of highlight context for email)
    nodemailer (Gmail SMTP → student email with inline CID images)
```

### Layers

| Layer | What lives here | Files |
|---|---|---|
| UI | Server + client React components, PDF viewer with custom text-layer highlight, SSE subscription, optimistic state, localStorage UI prefs | `components/`, `app/` |
| HTTP | Next.js Route Handlers (REST + SSE). Thin glue: validate → call lib → respond. Long jobs use `after()` to detach from the response. | `app/api/**/route.ts` |
| Agent | Prompt assembly, tool-use schemas, dual SDK/CLI routing, progress ticker, dismissal de-dupe, fallback marking, cross-report learning | `lib/agent/` |
| Checks | Cheap deterministic rules that run **before** the LLM: word count, required sections vs template, section-depth heuristic. Each is a pure function `(CheckContext) → RuleIssue[]`. | `lib/checks/` |
| Ingest | File → `{ html, plainText }`. PDF via `pdf2json` (no worker), DOCX via `mammoth`, `.doc` via `libreoffice` shell-out. Header regex pulls student name + email. | `lib/ingest/` |
| Output | PDF export (review PDF), Playwright PNG screenshot per issue for the email body. | `lib/pdf/` |
| Email | Gmail SMTP via nodemailer; inline `cid:` PNGs; CRITICAL-only filter; marking deliberately stripped before send. | `lib/email/` |
| Storage | Filesystem-backed `save(bucket, name, buf)` returning a relative path; designed to swap to S3/GCS by replacing one module. | `lib/storage.ts` |
| DB | Postgres + Prisma. JSON columns for `marking`, `reviewProgress`, `markingScheme` — schemaless tail of evolving agent output. | `prisma/schema.prisma` |

### Data model

```
KbTemplate  1───*  Report  1───*  Issue
                    │
                    ├── templateId   ── soft FK to the pinned scheme
                    ├── marking      JSON (overall, perSection, baselines, passive penalties)
                    ├── reviewProgress JSON (stage, steps[], counts, error)
                    └── enabledSkills String[]  (subset of SKILLS by id)

KbSample (EXCELLENT|BAD)     → calibration corpus, shared across reports
LearnedRejection             → cross-report dismissal hits (normalizedDesc → hitCount)
```

Key fields worth noting:
- `Issue.deleted` is a **soft delete**. Dismissed issues are kept so the next review pass can suppress near-duplicates and feed the cross-report `LearnedRejection` counter.
- `Report.marking.baselineOverall` + `baselinePenalty` snapshot what Claude scored on the last full run so per-issue edits can move the score *relative* to that baseline (`recomputeMarking` in `lib/agent/marking.ts`) without re-paying for an LLM call.
- `Report.reviewProgress.steps[]` is the preflight checklist rendered in the right sidebar. The reviewer route writes it, and `mergePreflightSteps` re-attaches it to every subsequent agent stage update so refreshes don't wipe the list.

### Review pipeline (the hot path)

`POST /api/reports/[id]/review` → response in <1s, work continues via `after()`:

```
1. Word-count preflight                       ┐
2. runAllChecks() — deterministic rules       │  synchronous,
3. Filter dismissed + globally-learned        │  in the request
4. Write RULE issues (atomic swap)            │  handler
5. Write reviewProgress = { stage: starting,  │
                            steps: [...] }    │
   publish() to SSE                           ┘

   ── response 202 → client opens EventSource ──

6. after(): reviewReport(id) starts                       ┐
   a. Load templates (pinned or all) + samples            │
   b. Build dismissedBlob from soft-deleted Issues        │  agent stage
   c. buildLearnedRejectionBlob() — global hints          │  (runs in
   d. Heartbeat ticker every 4s → setProgress() → SSE     │   background
   e. Call Claude:                                        │   process)
       SDK path: messages.create({                        │
         tools: [report_issues],                          │
         tool_choice: { name: "report_issues" },          │
         cache_control on system / templates / samples    │
       })                                                 │
       CLI path: spawn `claude -p --json --schema=…`      │
   f. ReviewOutputSchema.parse(toolUse.input)             │
   g. Drop dismissed-duplicates (fuzzy normalize)         │
   h. Snap quotedText offsets into plainText              │
   i. $transaction: deleteMany(AGENT) + createMany(new)   │
   j. setProgress(marking-running)                        │
   k. Second LLM call for marking (or fallback compute)   │
   l. applyPassiveDeletionPenalty()                       │
   m. status = REVIEWED, publish(reviewed)                ┘
```

Failure modes baked in:
- **Cancellation:** `registerAbort(reportId)` returns an `AbortController` stored on `globalThis` (so HMR doesn't fragment it). `/review/cancel` calls `triggerAbort` → SDK call aborts → status reverts to `UPLOADED`, progress `cancelled`.
- **SSE drop:** `ReportViewer` polls `/api/reports/[id]` every 5s as a fallback so the terminal transition is never missed (dev HMR, server restarts).
- **LLM marking fails:** `fallbackMarkingFromIssues()` computes a deterministic score from the live issues × the template's `markingScheme.penalties` so the marking card is never blank.
- **CLI not logged in:** error message tells the user to run `claude /login`.
- **Stale reviewProgress.steps:** every agent-stage update goes through `mergePreflightSteps` so the checklist survives later writes.

### Dual LLM transport

```
ANTHROPIC_API_KEY set?
        │
   ┌────┴────┐
   ▼         ▼
  SDK       CLI fallback
   │         │
   │         └─► spawns `claude -p --output-format json --json-schema --bare`
   │              (uses the developer's Claude Code login; useful for
   │               local dev without provisioning a billing-enabled key)
   ▼
   • tool_choice: forces `report_issues` so the response is always a structured tool_use
   • cache_control: ephemeral on system prompt, templates blob, samples blob
   • For N reports against the same KB → input cost drops ~90% on calls 2..N
```

The CLI path skips `cache_control` (CLI doesn't expose it) and uses `--json-schema` to constrain output to the same Zod schema (`ReviewOutputSchema`, `MarkingOutputSchema`).

### Skills system

Skills are review directives injected into the system prompt. `enabledSkills: string[]` on the Report lets each report turn skills on/off independently. Built-ins: `structure-compliance`, `format-style`, `grammar-prose`, `section-quality`, plus more in `lib/agent/skills.ts`. Skills are how product-side review behaviour (e.g. "don't flag PDF text-extraction fragments as misspellings") is expressed without touching agent code.

### Learning loop

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
isDismissedDuplicate() also filters anything Claude re-surfaces
post-tool-call (belt + braces)
```

Result: the same false positive never has to be deleted twice on the same report, and patterns dismissed repeatedly across many reports become global "do not flag" rules — without retraining or fine-tuning.

### Marking scheme

Generated once per template (and on demand when missing) by parsing top-level numbered headings out of the template's plaintext (`extractTopics` in `lib/agent/markingScheme.ts`). Encodes:
- `totalPoints` budget (100)
- `topics[]` — heading, weight, required-flag
- `wordCountBand` — min/max
- `penalties` — per-category deduction weights used by the deterministic recompute

When the LLM marking call fails, the same scheme drives the fallback score, so the system **degrades gracefully** rather than going blank.

### Concurrency + lifetime

- One review at a time per report — enforced by checking `status === "REVIEWING"` at the route handler and by the per-report `AbortController`.
- Heartbeat ticker every 4s while the agent runs so SSE subscribers and the elapsed-seconds counter on the UI stay live during a multi-minute LLM call.
- `maxDuration = 600` on the review route — fits on Vercel hobby and large local jobs.
- `globalThis`-keyed Maps for SSE subscribers + abort controllers survive HMR in dev; in prod they live for the process lifetime.

### Trust + safety boundaries

- Email sending requires `report.status ∈ {APPROVED, SENT}` AND a syntactically valid student email saved on the report.
- `marking` is **never** included in the email — the perSection scores stay reviewer-internal.
- Screenshots are rendered from `plainText` (server-controlled context window around the quoted span), not the raw uploaded file — no third-party JS executes during the screenshot.
- File uploads are restricted to `.pdf` (preserves formatting, lowest extraction-edge risk). DOCX/`.doc` ingest paths remain in `lib/ingest/toHtml.ts` for legacy reports already in the DB but are not user-facing at the upload endpoint.

## Prompt caching

`reviewer.ts` marks the system prompt + templates blob + samples blob with `cache_control: ephemeral`. For batches of N reports against the same KB, input cost drops ~90% on calls 2..N. (SDK path only — CLI fallback bypasses cache_control.)

## Claude auth modes

| Env state | Path |
|---|---|
| `ANTHROPIC_API_KEY` set | `@anthropic-ai/sdk` with tool-use + prompt caching |
| `ANTHROPIC_API_KEY` empty/unset | `claude` CLI (`-p --output-format json --json-schema --bare`) using the user's Claude Code login |

If CLI fallback hits "Not logged in", the API surfaces a clear error pointing at `claude /login`.

## Out of scope (MVP)

- Multi-reviewer accounts / auth
- Cloud blob storage (filesystem abstracted for swap)
- Background job queue (review runs inline via `after()`; `maxDuration` set to 600s)
- Showing marking to student
