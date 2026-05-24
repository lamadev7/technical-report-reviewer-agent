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
| Email | Resend (inline PNG screenshots) |
| DOCX → HTML | `mammoth` |
| PDF → HTML | `pdfjs-dist` (legacy build, text-layer) |
| `.doc` | `libreoffice --headless` → DOCX → mammoth |
| Screenshots | Playwright headless Chromium |

## Setup

```bash
nvm use                          # picks Node 20.20.2 from .nvmrc
pnpm install
pnpm exec playwright install chromium   # download browser for screenshots
cp .env.example .env             # set DATABASE_URL, ANTHROPIC_API_KEY, RESEND_*
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
| `RESEND_API_KEY` | Required for /send |
| `RESEND_FROM_EMAIL` | "From" address (must be verified in Resend) |
| `STORAGE_DIR` | Defaults to `./storage` |
| `APP_URL` | Defaults to `http://localhost:3000` |

## User flow

1. `/knowledge` — upload at least one **template**, optionally **excellent** and **bad** samples.
2. `/` — drop a student report (`.pdf` / `.docx` / `.doc`), pick **Review mode** and **Marking mode**, upload.
3. `/report/[id]` opens. Click **Review** — agent flags critical/major issues + computes marking.
4. Hover any highlight in the document for issue details. Right panel: edit comment text/severity/category, delete, or select text and **+Add** a manual comment.
5. **Approve** → enables **Send feedback to <email>** (only visible if report header had a student email).
6. Email goes via Resend with one PNG screenshot per issue inline; marking is **never** included in the email.

## Highlight colors

| Severity | Color | Notes |
|---|---|---|
| CRITICAL | red | template/section/grammar that blocks meaning |
| MAJOR | orange | significant but non-blocking |
| MINOR | — | never highlighted (spec) |

## Architecture

```
Browser ──► Next.js routes ──► Postgres (Prisma)
                │
                ├─► storage/         (uploaded files, screenshots)
                ├─► Anthropic API    (review + marking, prompt caching enabled)
                ├─► Playwright       (PNG of highlight context for email)
                └─► Resend           (HTML email with inline CID images)
```

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
- Background job queue (review runs inline; `maxDuration` set to 300s)
- Showing marking to student
