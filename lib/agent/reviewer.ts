import { prisma } from "@/lib/db";
import { anthropic, MODEL } from "./anthropic";
import { runClaudeCliJson, claudeCliAvailable, ClaudeCliError } from "./cli";
import { REVIEW_SYSTEM_BASE, rubricFor, MARKING_SYSTEM_BASE, markingRubricFor, type Mode } from "./prompts";
import { buildSkillsSection, defaultSkillIds } from "./skills";
import { ReviewOutputSchema, MarkingOutputSchema, reviewToolSchema, markingToolSchema } from "./schema";
import { publish, registerAbort, clearAbort, type ReviewProgress } from "./reviewBus";
import { applyPassiveDeletionPenalty } from "./marking";
import { buildLearnedRejectionBlob } from "./learning";

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

function useCli(): boolean {
  return !process.env.ANTHROPIC_API_KEY;
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

  await setProgress(reportId, {
    stage: "agent-running",
    ruleCount: ruleIssues.length,
    startedAt: startedAt.toISOString(),
    message: "Running semantic review (Claude)…",
  });

  // --- Route: CLI fallback if no API key set ---
  if (useCli()) {
    if (!claudeCliAvailable()) {
      throw new Error("ANTHROPIC_API_KEY not set and `claude` CLI not found on PATH. Install Claude Code CLI or set ANTHROPIC_API_KEY in .env.");
    }
    const reviewUserPrompt = [
      `Templates the report must follow:\n\n${templatesBlob || "(no templates provided)"}`,
      `Calibration samples:\n\n${samplesBlob || "(no samples provided)"}`,
      `Already-flagged issues from automated checks (DO NOT re-report these — focus on semantic problems they miss):\n${ruleBlob}`,
      dismissedContext,
      learnedBlob,
      `=== STUDENT REPORT (filename: ${report.filename}) ===\n${reportText}`,
      `\nReturn JSON only matching the schema. No prose, no markdown fences.`,
    ].filter(Boolean).join("\n\n");
    const reviewSystem = [
      REVIEW_SYSTEM_BASE,
      rubricFor(reviewMode),
      skillsBlob,
      `Output format: JSON only matching the provided schema. Do not call any tools.`,
    ].filter(Boolean).join("\n\n");
    let parsedCli: any;
    const stopReviewTicker = startProgressTicker(reportId, {
      stage: "agent-running",
      ruleCount: ruleIssues.length,
      startedAt: startedAt.toISOString(),
      message: "Semantic review running (Claude CLI)",
    });
    try {
      parsedCli = await runClaudeCliJson({
        systemPrompt: reviewSystem,
        userPrompt: reviewUserPrompt,
        jsonSchema: reviewToolSchema.input_schema,
        signal,
      });
    } catch (e: any) {
      if (signal.aborted || isAbortError(e)) throw e;
      throw new Error(`claude CLI review failed: ${e.message}${e instanceof ClaudeCliError && e.stderr ? `\n${e.stderr.slice(0, 300)}` : ""}`);
    } finally {
      stopReviewTicker();
    }
    if (signal.aborted) throw new Error("cancelled");
    const parsed = ReviewOutputSchema.parse(parsedCli);
    const dedupedCli = parsed.issues.filter(
      (iss) =>
        !isDismissedDuplicate(
          { quotedText: iss.quotedText, shortDescription: iss.shortDescription },
          dismissedIssues,
        ),
    );
    const issueRecords = dedupedCli.map((iss) => {
      let start = report.plainText.indexOf(iss.quotedText);
      if (start < 0) {
        const norm = iss.quotedText.replace(/\s+/g, " ").trim();
        const idx = report.plainText.replace(/\s+/g, " ").indexOf(norm);
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
      ...(issueRecords.length
        ? [prisma.issue.createMany({ data: issueRecords })]
        : []),
    ]);

    await setProgress(reportId, {
      stage: "marking-running",
      ruleCount: ruleIssues.length,
      agentCount: issueRecords.length,
      startedAt: startedAt.toISOString(),
      message: "Computing marks…",
    });

    // Marking via CLI
    const markingUserPrompt = [
      `Templates:\n${templatesBlob || "(none)"}`,
      `Samples:\n${samplesBlob || "(none)"}`,
      `Student report:\n${reportText}`,
      `\nReturn JSON only matching the schema. No prose, no markdown fences.`,
    ].join("\n\n");
    const markingSystem = [
      MARKING_SYSTEM_BASE,
      markingRubricFor(markingMode),
      `Output format: a SINGLE JSON object — no prose, no markdown fences, no tool calls.`,
      `Required shape:`,
      `{"overall": <int 0-100>, "perSection": [{"title": "<section name>", "score": <int 0-100>, "note": "<optional short note>"} , ...]}`,
      `Example:`,
      `{"overall": 72, "perSection": [{"title": "Introduction", "score": 80, "note": "Clear scope"}, {"title": "Methodology", "score": 65, "note": "Missing tools justification"}, {"title": "Conclusion", "score": 70}]}`,
      `Both "overall" and "perSection" are REQUIRED. perSection must have at least one item.`,
    ].join("\n\n");
    let marking: any = null;
    const stopMarkingTicker = startProgressTicker(reportId, {
      stage: "marking-running",
      ruleCount: ruleIssues.length,
      agentCount: issueRecords.length,
      startedAt: startedAt.toISOString(),
      message: "Computing marks (Claude CLI)",
    });
    try {
      for (let attempt = 1; attempt <= 2 && !marking; attempt++) {
        try {
          const m = await runClaudeCliJson({
            systemPrompt: markingSystem,
            userPrompt: markingUserPrompt,
            jsonSchema: markingToolSchema.input_schema,
            timeoutMs: 180_000,
            signal,
          });
          marking = MarkingOutputSchema.parse(m);
        } catch (e: any) {
          if (signal.aborted || isAbortError(e)) throw e;
          console.warn(`claude CLI marking attempt ${attempt} failed:`, e.message);
        }
      }
    } finally {
      stopMarkingTicker();
    }
    if (signal.aborted) throw new Error("cancelled");
    if (!marking) marking = await fallbackMarkingFromIssues(reportId);
    marking = await applyPassiveDeletionPenalty(reportId, marking);
    const finalCli: ReviewProgress = {
      stage: "reviewed",
      ruleCount: ruleIssues.length,
      agentCount: issueRecords.length,
      startedAt: startedAt.toISOString(),
      steps: preflightSteps,
    };
    await prisma.report.update({
      where: { id: reportId },
      data: { status: "REVIEWED", marking, reviewProgress: finalCli as any },
    });
    publish(reportId, finalCli);
    return { issueCount: issueRecords.length, marking, via: "cli" };
  }

  // --- Review call (SDK path) ---
  const stopReviewTickerSdk = startProgressTicker(reportId, {
    stage: "agent-running",
    ruleCount: ruleIssues.length,
    startedAt: startedAt.toISOString(),
    message: "Semantic review running (Claude SDK)",
  });
  let reviewMsg;
  try {
    reviewMsg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: [
        { type: "text", text: REVIEW_SYSTEM_BASE, cache_control: { type: "ephemeral" } },
        { type: "text", text: rubricFor(reviewMode) },
        ...(skillsBlob ? [{ type: "text" as const, text: skillsBlob }] : []),
      ],
      tools: [reviewToolSchema as any],
      tool_choice: { type: "tool", name: "report_issues" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Templates the report must follow:\n\n${templatesBlob || "(no templates provided)"}`, cache_control: { type: "ephemeral" } },
            { type: "text", text: `Calibration samples:\n\n${samplesBlob || "(no samples provided)"}`, cache_control: { type: "ephemeral" } },
            { type: "text", text: `Already-flagged issues from automated checks (DO NOT re-report — focus on semantic findings these miss):\n${ruleBlob}` },
            { type: "text", text: dismissedContext },
            ...(learnedBlob ? [{ type: "text" as const, text: learnedBlob }] : []),
            { type: "text", text: `=== STUDENT REPORT (filename: ${report.filename}) ===\n${reportText}` },
          ],
        },
      ],
    }, { signal });
  } finally {
    stopReviewTickerSdk();
  }
  if (signal.aborted) throw new Error("cancelled");

  const reviewBlock = reviewMsg.content.find((b) => b.type === "tool_use");
  if (!reviewBlock || reviewBlock.type !== "tool_use") throw new Error("Claude did not call report_issues tool");
  const parsed = ReviewOutputSchema.parse(reviewBlock.input);

  // Drop any finding Claude re-surfaced that the reviewer previously deleted
  // — keeps dismissals sticky across reruns, even when token-saving prompt
  // hints failed to convince the model.
  const dedupedSdk = parsed.issues.filter(
    (iss) =>
      !isDismissedDuplicate(
        { quotedText: iss.quotedText, shortDescription: iss.shortDescription },
        dismissedIssues,
      ),
  );

  // Snap offsets to actual occurrences of quotedText in report.plainText for higher accuracy
  const text = report.plainText;
  const issueRecords = dedupedSdk.map((iss) => {
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

  // Atomic swap (see CLI path note above).
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
  const stopMarkingTickerSdk = startProgressTicker(reportId, {
    stage: "marking-running",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
    message: "Computing marks (Claude SDK)",
  });
  let marking: any = null;
  try {
    for (let attempt = 1; attempt <= 2 && !marking; attempt++) {
      try {
        const markingMsg = await anthropic().messages.create({
          model: MODEL,
          max_tokens: 1500,
          system: [
            { type: "text", text: MARKING_SYSTEM_BASE, cache_control: { type: "ephemeral" } },
            { type: "text", text: markingRubricFor(markingMode) },
          ],
          tools: [markingToolSchema as any],
          tool_choice: { type: "tool", name: "submit_marking" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Templates:\n${templatesBlob || "(none)"}`, cache_control: { type: "ephemeral" } },
                { type: "text", text: `Samples:\n${samplesBlob || "(none)"}`, cache_control: { type: "ephemeral" } },
                { type: "text", text: `Student report:\n${reportText}` },
              ],
            },
          ],
        }, { signal });
        const markBlock = markingMsg.content.find((b) => b.type === "tool_use");
        if (markBlock && markBlock.type === "tool_use") {
          marking = MarkingOutputSchema.parse(markBlock.input);
        }
      } catch (e: any) {
        if (signal.aborted || isAbortError(e)) throw e;
        console.warn(`claude SDK marking attempt ${attempt} failed:`, e?.message || e);
      }
    }
  } finally {
    stopMarkingTickerSdk();
  }
  if (signal.aborted) throw new Error("cancelled");
  if (!marking) marking = await fallbackMarkingFromIssues(reportId);
  marking = await applyPassiveDeletionPenalty(reportId, marking);

  const finalSdk: ReviewProgress = {
    stage: "reviewed",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
    steps: preflightSteps,
  };
  await prisma.report.update({
    where: { id: reportId },
    data: { status: "REVIEWED", marking, reviewProgress: finalSdk as any },
  });
  publish(reportId, finalSdk);

  return { issueCount: issueRecords.length, marking, via: "sdk" as const };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n\n[…truncated for length…]";
}
