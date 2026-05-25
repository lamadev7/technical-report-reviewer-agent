import { prisma } from "@/lib/db";
import { getProvider } from "./llm";
import type { LlmAttachment } from "./llm/types";
import { load as loadStorage } from "@/lib/storage";
import { REVIEW_SYSTEM_BASE, rubricFor, MARKING_SYSTEM_BASE, markingRubricFor, type Mode } from "./prompts";
import { buildSkillsSection, defaultSkillIds } from "./skills";
import { ReviewOutputSchema, MarkingOutputSchema, reviewToolSchema, markingToolSchema } from "./schema";
import { publish, registerAbort, clearAbort, type ReviewProgress } from "./reviewBus";
import { applyPassiveDeletionPenalty } from "./marking";
import { buildLearnedRejectionBlob } from "./learning";

// PDFs larger than this are skipped — Gemini caps inline data at 20MB, and
// passing a huge document blows up latency. Most student reports are <5MB.
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

// Best-effort PDF load for multimodal providers. Returns null when no PDF is
// available, the file is missing, or it exceeds the size cap — caller falls
// back to text-only review.
async function loadReportAttachment(
  originalPath: string | null | undefined,
): Promise<LlmAttachment | null> {
  if (!originalPath || !originalPath.toLowerCase().endsWith(".pdf")) return null;
  try {
    const buf = await loadStorage(originalPath);
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(`Report PDF ${originalPath} (${buf.length} bytes) exceeds attachment cap — sending text-only`);
      return null;
    }
    return {
      mimeType: "application/pdf",
      data: buf,
      description: "student report PDF",
    };
  } catch (e: any) {
    console.warn(`Failed to load report PDF ${originalPath} for attachment: ${e.message}`);
    return null;
  }
}

// Tokens for fuzzy matching. Strips punctuation, lowercases, collapses
// whitespace. A new finding is considered a duplicate of a dismissed one when
// its quotedText shares a significant prefix OR its shortDescription matches
// closely after normalization.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
}

function isDismissedDuplicate(
  candidate: { quotedText: string; shortDescription: string },
  dismissed: Array<{ quotedText: string; shortDescription: string }>,
): boolean {
  const q = normalize(candidate.quotedText).slice(0, 60);
  const d = normalize(candidate.shortDescription);
  if (!q && !d) return false;
  for (const old of dismissed) {
    const oq = normalize(old.quotedText).slice(0, 60);
    const od = normalize(old.shortDescription);
    if (q && oq && (q === oq || q.startsWith(oq) || oq.startsWith(q))) return true;
    if (d && od && d === od) return true;
  }
  return false;
}

async function setProgress(reportId: string, progress: ReviewProgress) {
  // Preserve preflight `steps` written by the review/route.ts so subsequent
  // agent/marking stage updates don't wipe the checklist out of the JSON.
  const merged = await mergePreflightSteps(reportId, progress);
  await prisma.report.update({ where: { id: reportId }, data: { reviewProgress: merged as any } });
  publish(reportId, merged);
}

async function mergePreflightSteps(reportId: string, progress: ReviewProgress): Promise<ReviewProgress> {
  if (progress.steps && progress.steps.length) return progress;
  const cur = await prisma.report
    .findUnique({ where: { id: reportId }, select: { reviewProgress: true } })
    .catch(() => null);
  const prevSteps = (cur?.reviewProgress as any)?.steps;
  return prevSteps ? { ...progress, steps: prevSteps } : progress;
}

// While a long-running Claude call is in flight there are no natural progress
// events between "agent-running" and "agent-done". This keeps SSE subscribers
// alive with a synthetic tick every few seconds so a client that revisits
// mid-review immediately sees an up-to-date label/heartbeat rather than the
// stale snapshot pulled from the DB at subscription time.
function startProgressTicker(reportId: string, base: ReviewProgress, intervalMs = 4_000) {
  const start = Date.now();
  let cachedSteps: ReviewProgress["steps"] | undefined = base.steps;
  const fire = async () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (!cachedSteps) {
      const cur = await prisma.report
        .findUnique({ where: { id: reportId }, select: { reviewProgress: true } })
        .catch(() => null);
      cachedSteps = (cur?.reviewProgress as any)?.steps;
    }
    const evt: ReviewProgress = {
      ...base,
      message: `${base.message ?? "Reviewing"} (${elapsed}s elapsed)`,
      steps: cachedSteps,
    };
    await prisma.report
      .update({ where: { id: reportId }, data: { reviewProgress: evt as any } })
      .catch(() => {});
    publish(reportId, evt);
  };
  const timer = setInterval(() => { void fire(); }, intervalMs);
  return () => clearInterval(timer);
}

const MAX_REPORT_CHARS = 60_000; // ~15k tokens for 6k words; cap to keep prompt reasonable
const MAX_SAMPLE_CHARS = 6_000;
const MAX_TEMPLATE_CHARS = 8_000;

// When the LLM marking call fails (timeouts, parse errors, rate limits) the
// review otherwise looks like it succeeded — issues persisted, status flipped
// to REVIEWED — but the marking card stays blank. Compute a deterministic
// baseline from the current open issues so the reviewer always sees a score.
async function fallbackMarkingFromIssues(reportId: string): Promise<any> {
  const [issues, report] = await Promise.all([
    prisma.issue.findMany({
      where: { reportId, deleted: false },
      select: { category: true, shortDescription: true, severity: true },
    }),
    prisma.report.findUnique({
      where: { id: reportId },
      select: { template: { select: { markingScheme: true } } },
    }),
  ]);
  const scheme = (report?.template?.markingScheme as any) || null;
  const W = scheme?.penalties || {
    grammar: 0.25,
    format: 5,
    completeness: 5,
    sectionUnder: 1,
    sectionOver: 0.5,
    other: 0.5,
  };
  const penalty = issues.reduce((acc, i) => {
    const d = i.shortDescription.toLowerCase();
    switch (i.category) {
      case "GRAMMAR": return acc + W.grammar;
      case "FORMAT": return acc + W.format;
      case "COMPLETENESS": return acc + W.completeness;
      case "SECTION_QUALITY":
        if (d.startsWith("[over]") || d.includes("over-explain")) return acc + W.sectionOver;
        return acc + W.sectionUnder;
      default: return acc + W.other;
    }
  }, 0);
  const baseline = scheme?.totalPoints ?? 85;
  const overall = Math.max(0, Math.min(100, Math.round(baseline - penalty)));
  // Derive per-section anchors from the scheme so the marking card shows
  // which topics the rubric expects.
  const perSection = scheme?.topics?.length
    ? scheme.topics.map((t: any) => ({
        title: t.heading,
        score: Math.round(t.weight),
        note: "scheme target weight",
      }))
    : [];
  return {
    overall,
    perSection,
    baselineOverall: overall,
    baselinePenalty: penalty,
    fallback: true,
    schemeId: scheme?.generatedAt ?? null,
  };
}

function isAbortError(e: any): boolean {
  if (!e) return false;
  if (e.name === "AbortError") return true;
  const msg = String(e?.message || e);
  return /aborted|cancelled/i.test(msg);
}

export async function reviewReport(reportId: string) {
  const ctrl = registerAbort(reportId);
  try {
    return await runReview(reportId, ctrl.signal);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (ctrl.signal.aborted || isAbortError(e)) {
      await prisma.report.update({
        where: { id: reportId },
        data: {
          status: "UPLOADED",
          reviewProgress: { stage: "cancelled", message: "Review cancelled by user" } as any,
        },
      }).catch(() => {});
      publish(reportId, { stage: "cancelled", message: "Review cancelled by user" });
      return { cancelled: true };
    }
    await prisma.report.update({
      where: { id: reportId },
      data: { status: "UPLOADED", reviewProgress: { stage: "failed", error: msg } as any },
    }).catch(() => {});
    publish(reportId, { stage: "failed", error: msg });
    throw e;
  } finally {
    clearAbort(reportId);
  }
}

async function runReview(reportId: string, signal: AbortSignal) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new Error("Report not found");

  // Preflight steps were written by the review/route.ts before kicking us off.
  // Capture them so we can re-attach them to every progress update we emit.
  const preflightSteps = (report.reviewProgress as any)?.steps;

  // If the reviewer pinned a specific template for this report, use only that
  // one — otherwise fall back to the full template library.
  const [templates, samples] = await Promise.all([
    prisma.kbTemplate.findMany({
      where: report.templateId ? { id: report.templateId } : {},
      orderBy: { createdAt: "asc" },
    }),
    prisma.kbSample.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  const templatesBlob = templates
    .map((t, i) => `=== TEMPLATE ${i + 1}: ${t.name} ===\n${truncate(t.plainText, MAX_TEMPLATE_CHARS)}`)
    .join("\n\n");
  const samplesBlob = samples
    .map((s, i) => `=== SAMPLE ${i + 1} [${s.quality}]: ${s.name} ===\n${truncate(s.plainText, MAX_SAMPLE_CHARS)}`)
    .join("\n\n");

  const reportText = truncate(report.plainText, MAX_REPORT_CHARS);
  const reviewMode = report.reviewMode as Mode;
  const markingMode = report.markingMode as Mode;
  const skillIds = report.enabledSkills?.length ? report.enabledSkills : defaultSkillIds();
  const skillsBlob = buildSkillsSection(skillIds);

  // The HTTP route handler already flipped status=REVIEWING and stamped
  // reviewStartedAt before kicking us off (so the SSE client can subscribe
  // before this function starts). If we were invoked directly (e.g. CLI), do
  // the same setup here.
  const startedAt = report.reviewStartedAt ?? new Date();
  if (report.status !== "REVIEWING") {
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: "REVIEWING",
        reviewStartedAt: startedAt,
        reviewProgress: { stage: "starting", startedAt: startedAt.toISOString() } as any,
      },
    });
    publish(reportId, { stage: "starting", startedAt: startedAt.toISOString() });
  }
  // Snapshot issues the reviewer previously dismissed (soft-deleted) BEFORE
  // we drop the live AGENT rows. We use these to (a) tell Claude not to
  // re-flag them and (b) auto-dismiss any matching findings the next run
  // produces, so the human reviewer doesn't have to delete the same item twice.
  const dismissedIssues = await prisma.issue.findMany({
    where: { reportId, deleted: true },
    select: { quotedText: true, shortDescription: true, category: true, severity: true, source: true },
    take: 200,
  });

  // Note: we used to wipe prior AGENT issues here, but that left the report
  // sidebar empty if the user refreshed mid-review. Now we keep them visible
  // and replace atomically AFTER the new ones parse successfully (see below).

  // Already-flagged issues from the deterministic rule pass — pass them to the
  // LLM as context so it focuses on semantic findings instead of re-reporting
  // spelling, missing sections, word count, etc.
  const ruleIssues = await prisma.issue.findMany({
    where: { reportId, source: "RULE", deleted: false },
    select: { quotedText: true, category: true, shortDescription: true },
    take: 80,
  });
  const ruleBlob = ruleIssues.length
    ? ruleIssues
        .map((i, n) => `${n + 1}. [${i.category}] "${i.quotedText.slice(0, 60)}" — ${i.shortDescription}`)
        .join("\n")
    : "(no rule-based findings)";

  const dismissedBlob = dismissedIssues.length
    ? dismissedIssues
        .map((i, n) => `${n + 1}. [${i.category}] "${i.quotedText.slice(0, 80)}" — ${i.shortDescription}`)
        .join("\n")
    : "(none)";
  const dismissedContext = `Previously dismissed issues (the reviewer explicitly deleted these on a prior pass — DO NOT re-report them or any near-duplicate. Even if the same span looks problematic, skip it):\n${dismissedBlob}`;

  // Cross-report learnings — patterns the reviewer has rejected many times.
  const learnedBlob = await buildLearnedRejectionBlob();

  const provider = getProvider();
  const providerLabel = provider.name === "anthropic" ? "Claude" : provider.name === "codex" ? "Codex" : "Gemini";

  // Multimodal providers (Anthropic SDK, Gemini) can ingest the original PDF
  // directly so the agent SEES scanned declarations, signatures, and logo
  // pages that text extraction misses. Codex (Chat Completions) and Anthropic
  // CLI ignore the attachment silently — text-only fallback.
  const supportsAttachments = provider.name === "anthropic" || provider.name === "gemini";
  const reportAttachment = supportsAttachments
    ? await loadReportAttachment(report.originalPath)
    : null;
  const attachmentNote = reportAttachment
    ? "ATTACHED: full student report PDF (pages may include image-only sections — declarations, signature blocks, logos. Inspect them visually before flagging missing structural sections; see FLEXIBLE SECTION MATCHING)."
    : "(no PDF attachment available — rely on extracted text only. DO NOT flag missing declarations or covers when text extraction may have skipped image-only pages.)";

  await setProgress(reportId, {
    stage: "agent-running",
    ruleCount: ruleIssues.length,
    startedAt: startedAt.toISOString(),
    message: `Running semantic review (${providerLabel})…`,
  });

  // --- Review call ---
  const reviewSystemSegments = [
    { text: REVIEW_SYSTEM_BASE, cache: true },
    { text: rubricFor(reviewMode) },
    ...(skillsBlob ? [{ text: skillsBlob }] : []),
  ];
  const reviewUserSegments = [
    { text: `Templates the report must follow:\n\n${templatesBlob || "(no templates provided)"}`, cache: true },
    { text: `Calibration samples:\n\n${samplesBlob || "(no samples provided)"}`, cache: true },
    { text: attachmentNote },
    { text: `Already-flagged issues from automated checks (DO NOT re-report — focus on semantic findings these miss):\n${ruleBlob}` },
    { text: dismissedContext },
    ...(learnedBlob ? [{ text: learnedBlob }] : []),
    { text: `=== STUDENT REPORT (filename: ${report.filename}) ===\n${reportText}` },
  ];

  const stopReviewTicker = startProgressTicker(reportId, {
    stage: "agent-running",
    ruleCount: ruleIssues.length,
    startedAt: startedAt.toISOString(),
    message: `Semantic review running (${providerLabel}${reportAttachment ? " + PDF" : ""})`,
  });
  let reviewResult: { json: unknown; via: string };
  try {
    reviewResult = await provider.generateJson({
      systemSegments: reviewSystemSegments,
      userSegments: reviewUserSegments,
      attachments: reportAttachment ? [reportAttachment] : undefined,
      schemaName: reviewToolSchema.name,
      schema: reviewToolSchema.input_schema,
      maxTokens: 8000,
      signal,
    });
  } catch (e: any) {
    if (signal.aborted || isAbortError(e)) throw e;
    throw new Error(`${providerLabel} review failed: ${e.message}`);
  } finally {
    stopReviewTicker();
  }
  if (signal.aborted) throw new Error("cancelled");

  const parsed = ReviewOutputSchema.parse(reviewResult.json);
  const dedupedIssues = parsed.issues.filter(
    (iss) =>
      !isDismissedDuplicate(
        { quotedText: iss.quotedText, shortDescription: iss.shortDescription },
        dismissedIssues,
      ),
  );

  const text = report.plainText;
  const issueRecords = dedupedIssues.map((iss) => {
    let start = text.indexOf(iss.quotedText);
    if (start < 0) {
      const norm = iss.quotedText.replace(/\s+/g, " ").trim();
      const idx = text.replace(/\s+/g, " ").indexOf(norm);
      start = idx < 0 ? (iss.startOffset ?? 0) : idx;
    }
    const end = start + iss.quotedText.length;
    return {
      reportId,
      startOffset: start,
      endOffset: end,
      quotedText: iss.quotedText,
      severity: iss.severity,
      category: iss.category,
      shortDescription: iss.shortDescription,
      source: "AGENT" as const,
    };
  });

  // Atomic swap: replace prior AGENT issues with this run's parse. Keeps the
  // sidebar populated mid-run and avoids a flicker of "no issues" on refresh.
  await prisma.$transaction([
    prisma.issue.deleteMany({ where: { reportId, source: "AGENT", deleted: false } }),
    ...(issueRecords.length ? [prisma.issue.createMany({ data: issueRecords })] : []),
  ]);

  await setProgress(reportId, {
    stage: "marking-running",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
    message: "Computing marks…",
  });

  // --- Marking call ---
  const markingSystemSegments = [
    { text: MARKING_SYSTEM_BASE, cache: true },
    { text: markingRubricFor(markingMode) },
  ];
  const markingUserSegments = [
    { text: `Templates:\n${templatesBlob || "(none)"}`, cache: true },
    { text: `Samples:\n${samplesBlob || "(none)"}`, cache: true },
    { text: `Student report:\n${reportText}` },
  ];

  const stopMarkingTicker = startProgressTicker(reportId, {
    stage: "marking-running",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
    message: `Computing marks (${providerLabel})`,
  });
  let marking: any = null;
  try {
    for (let attempt = 1; attempt <= 2 && !marking; attempt++) {
      try {
        const m = await provider.generateJson({
          systemSegments: markingSystemSegments,
          userSegments: markingUserSegments,
          schemaName: markingToolSchema.name,
          schema: markingToolSchema.input_schema,
          maxTokens: 1500,
          timeoutMs: 180_000,
          signal,
        });
        marking = MarkingOutputSchema.parse(m.json);
      } catch (e: any) {
        if (signal.aborted || isAbortError(e)) throw e;
        console.warn(`${providerLabel} marking attempt ${attempt} failed:`, e?.message || e);
      }
    }
  } finally {
    stopMarkingTicker();
  }
  if (signal.aborted) throw new Error("cancelled");
  if (!marking) marking = await fallbackMarkingFromIssues(reportId);
  marking = await applyPassiveDeletionPenalty(reportId, marking);

  const finalProgress: ReviewProgress = {
    stage: "reviewed",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
    steps: preflightSteps,
  };
  await prisma.report.update({
    where: { id: reportId },
    data: { status: "REVIEWED", marking, reviewProgress: finalProgress as any },
  });
  publish(reportId, finalProgress);

  return { issueCount: issueRecords.length, marking, via: reviewResult.via };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n\n[…truncated for length…]";
}
