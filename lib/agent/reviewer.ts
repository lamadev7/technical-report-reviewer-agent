import { prisma } from "@/lib/db";
import { anthropic, MODEL } from "./anthropic";
import { runClaudeCliJson, claudeCliAvailable, ClaudeCliError } from "./cli";
import { REVIEW_SYSTEM_BASE, rubricFor, MARKING_SYSTEM_BASE, markingRubricFor, type Mode } from "./prompts";
import { buildSkillsSection, defaultSkillIds } from "./skills";
import { ReviewOutputSchema, MarkingOutputSchema, reviewToolSchema, markingToolSchema } from "./schema";
import { publish, type ReviewProgress } from "./reviewBus";

async function setProgress(reportId: string, progress: ReviewProgress) {
  await prisma.report.update({ where: { id: reportId }, data: { reviewProgress: progress as any } });
  publish(reportId, progress);
}

// While a long-running Claude call is in flight there are no natural progress
// events between "agent-running" and "agent-done". This keeps SSE subscribers
// alive with a synthetic tick every few seconds so a client that revisits
// mid-review immediately sees an up-to-date label/heartbeat rather than the
// stale snapshot pulled from the DB at subscription time.
function startProgressTicker(reportId: string, base: ReviewProgress, intervalMs = 4_000) {
  const start = Date.now();
  const fire = async () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const evt: ReviewProgress = {
      ...base,
      message: `${base.message ?? "Reviewing"} (${elapsed}s elapsed)`,
    };
    // Persist on each tick so a brand-new SSE subscriber gets a recent snapshot
    // from the DB, not a 2-minute-old one.
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

export async function reviewReport(reportId: string) {
  try {
    return await runReview(reportId);
  } catch (e: any) {
    const msg = e?.message || String(e);
    await prisma.report.update({
      where: { id: reportId },
      data: { status: "UPLOADED", reviewProgress: { stage: "failed", error: msg } as any },
    }).catch(() => {});
    publish(reportId, { stage: "failed", error: msg });
    throw e;
  }
}

async function runReview(reportId: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw new Error("Report not found");

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
  // Clear prior AGENT issues for this report so a re-run is idempotent.
  await prisma.issue.deleteMany({ where: { reportId, source: "AGENT" } });

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
      `=== STUDENT REPORT (filename: ${report.filename}) ===\n${reportText}`,
      `\nReturn JSON only matching the schema. No prose, no markdown fences.`,
    ].join("\n\n");
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
      });
    } catch (e: any) {
      throw new Error(`claude CLI review failed: ${e.message}${e instanceof ClaudeCliError && e.stderr ? `\n${e.stderr.slice(0, 300)}` : ""}`);
    } finally {
      stopReviewTicker();
    }
    const parsed = ReviewOutputSchema.parse(parsedCli);
    const issueRecords = parsed.issues.map((iss) => {
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
    if (issueRecords.length) await prisma.issue.createMany({ data: issueRecords });

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
      const m = await runClaudeCliJson({
        systemPrompt: markingSystem,
        userPrompt: markingUserPrompt,
        jsonSchema: markingToolSchema.input_schema,
        timeoutMs: 180_000,
      });
      marking = MarkingOutputSchema.parse(m);
    } catch (e: any) {
      // Marking is non-critical; log + continue.
      console.warn("claude CLI marking failed:", e.message);
    } finally {
      stopMarkingTicker();
    }
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: "REVIEWED",
        marking,
        reviewProgress: {
          stage: "reviewed",
          ruleCount: ruleIssues.length,
          agentCount: issueRecords.length,
          startedAt: startedAt.toISOString(),
        } as any,
      },
    });
    publish(reportId, {
      stage: "reviewed",
      ruleCount: ruleIssues.length,
      agentCount: issueRecords.length,
      startedAt: startedAt.toISOString(),
    });
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
            { type: "text", text: `=== STUDENT REPORT (filename: ${report.filename}) ===\n${reportText}` },
          ],
        },
      ],
    });
  } finally {
    stopReviewTickerSdk();
  }

  const reviewBlock = reviewMsg.content.find((b) => b.type === "tool_use");
  if (!reviewBlock || reviewBlock.type !== "tool_use") throw new Error("Claude did not call report_issues tool");
  const parsed = ReviewOutputSchema.parse(reviewBlock.input);

  // Snap offsets to actual occurrences of quotedText in report.plainText for higher accuracy
  const text = report.plainText;
  const issueRecords = parsed.issues.map((iss) => {
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

  if (issueRecords.length) await prisma.issue.createMany({ data: issueRecords });

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
  let markingMsg;
  try {
    markingMsg = await anthropic().messages.create({
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
    });
  } finally {
    stopMarkingTickerSdk();
  }

  const markBlock = markingMsg.content.find((b) => b.type === "tool_use");
  let marking = null as any;
  if (markBlock && markBlock.type === "tool_use") {
    marking = MarkingOutputSchema.parse(markBlock.input);
  }

  await prisma.report.update({
    where: { id: reportId },
    data: {
      status: "REVIEWED",
      marking,
      reviewProgress: {
        stage: "reviewed",
        ruleCount: ruleIssues.length,
        agentCount: issueRecords.length,
        startedAt: startedAt.toISOString(),
      } as any,
    },
  });
  publish(reportId, {
    stage: "reviewed",
    ruleCount: ruleIssues.length,
    agentCount: issueRecords.length,
    startedAt: startedAt.toISOString(),
  });

  return { issueCount: issueRecords.length, marking, via: "sdk" as const };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + "\n\n[…truncated for length…]";
}
