import { Resend } from "resend";
import { prisma } from "@/lib/db";
import { screenshotIssue } from "@/lib/pdf/screenshot";

const CONTEXT_RADIUS = 220;

export async function sendReportFeedback(reportId: string) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: { issues: { where: { deleted: false }, orderBy: { startOffset: "asc" } } },
  });
  if (!report) throw new Error("Report not found");
  if (!report.studentEmail) throw new Error("Report has no student email — cannot send");
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  if (!process.env.RESEND_FROM_EMAIL) throw new Error("RESEND_FROM_EMAIL not set");

  const resend = new Resend(process.env.RESEND_API_KEY);
  const attachments: { filename: string; content: string; content_id?: string; contentType?: string }[] = [];
  const issueHtml: string[] = [];

  for (let i = 0; i < report.issues.length; i++) {
    const iss = report.issues[i];
    const before = report.plainText.slice(Math.max(0, iss.startOffset - CONTEXT_RADIUS), iss.startOffset);
    const after = report.plainText.slice(iss.endOffset, iss.endOffset + CONTEXT_RADIUS);
    const png = await screenshotIssue({
      contextBefore: before,
      quotedText: iss.quotedText,
      contextAfter: after,
      severity: iss.severity,
      category: iss.category,
      shortDescription: iss.shortDescription,
    });
    const cid = `issue-${iss.id}@reviewer`;
    attachments.push({
      filename: `issue-${i + 1}.png`,
      content: png.toString("base64"),
      content_id: cid,
      contentType: "image/png",
    });
    issueHtml.push(`
      <li style="margin-bottom: 16px;">
        <div><strong>${iss.severity} · ${iss.category}</strong></div>
        <div>${escapeHtml(iss.shortDescription)}</div>
        <img src="cid:${cid}" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin-top: 6px;" alt="issue ${i + 1}"/>
      </li>`);
  }

  const html = `
    <div style="font: 14px/1.6 -apple-system, system-ui, sans-serif; color: #111; max-width: 720px;">
      <p>Hi ${escapeHtml(report.studentName || "")},</p>
      <p>Your report <em>${escapeHtml(report.filename)}</em> has been reviewed. Below are the issues to address:</p>
      <ol>${issueHtml.join("")}</ol>
      <p style="color: #666; font-size: 12px;">— Report Reviewer</p>
    </div>`;

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to: report.studentEmail,
    subject: `Report feedback: ${report.filename}`,
    html,
    attachments,
  });

  await prisma.report.update({ where: { id: reportId }, data: { status: "SENT" } });
  return { sent: true, count: report.issues.length };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
