import nodemailer from "nodemailer";
import { prisma } from "@/lib/db";
import { screenshotIssue } from "@/lib/pdf/screenshot";
import { countMajorWords } from "@/lib/checks/majorContent";

const CONTEXT_RADIUS = 220;

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user) throw new Error("GMAIL_USER not set");
  if (!pass) throw new Error("GMAIL_APP_PASSWORD not set (generate at https://myaccount.google.com/apppasswords)");
  // Explicit host/port instead of `service: "gmail"` (which defaults to
  // smtp.gmail.com:465 SSL). Many networks/ISPs block 465; 587 with STARTTLS
  // is more reliable and is Gmail's recommended submission port.
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export async function sendReportFeedback(reportId: string) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: { issues: { where: { deleted: false, severity: "CRITICAL" }, orderBy: { startOffset: "asc" } } },
  });
  if (!report) throw new Error("Report not found");
  if (!report.studentEmail) throw new Error("Report has no student email — cannot send");

  const transporter = getTransporter();
  const attachments: { filename: string; content: Buffer; cid: string; contentType?: string }[] = [];
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
      content: png,
      cid,
      contentType: "image/png",
    });
    issueHtml.push(`
      <li style="margin-bottom: 16px;">
        <div><strong>${iss.severity} · ${iss.category}</strong></div>
        <div>${escapeHtml(iss.shortDescription)}</div>
        <img src="cid:${cid}" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin-top: 6px;" alt="issue ${i + 1}"/>
      </li>`);
  }

  // Compute major-content word count (same logic the rule pass uses) so the
  // banner matches the rule findings and the UI badge — counting the FULL
  // plaintext made the email disagree with the rest of the system.
  const wordCount = countMajorWords(report.plainText);
  const min = report.wordCountMin;
  const max = report.wordCountMax;
  let wcMsg: { tone: "ok" | "fail"; text: string };
  if (min > 0 && wordCount < min) {
    wcMsg = { tone: "fail", text: `CRITICAL — word count is ${wordCount.toLocaleString()}, below the required minimum of ${min.toLocaleString()}.` };
  } else if (max > 0 && wordCount > max) {
    wcMsg = { tone: "fail", text: `CRITICAL — word count is ${wordCount.toLocaleString()}, above the allowed maximum of ${max.toLocaleString()}.` };
  } else {
    wcMsg = { tone: "ok", text: `Word count ${wordCount.toLocaleString()} (within ${min || "—"}–${max || "—"})` };
  }
  const wcBanner = `<div style="margin: 8px 0 14px; padding: 8px 12px; border-radius: 4px; border: 1px solid ${wcMsg.tone === "fail" ? "#fca5a5" : "#a7f3d0"}; background: ${wcMsg.tone === "fail" ? "#fef2f2" : "#ecfdf5"}; color: ${wcMsg.tone === "fail" ? "#991b1b" : "#065f46"}; font-size: 13px;">${escapeHtml(wcMsg.text)}</div>`;

  const html = `
    <div style="font: 14px/1.6 -apple-system, system-ui, sans-serif; color: #111; max-width: 720px;">
      <p>Hi ${escapeHtml(report.studentName || "")},</p>
      ${wcBanner}
      ${
        report.issues.length
          ? `<p>Your report <em>${escapeHtml(report.filename)}</em> has been reviewed. Below are the <strong>critical</strong> issues to address:</p>
             <ol>${issueHtml.join("")}</ol>`
          : `<p>Your report <em>${escapeHtml(report.filename)}</em> has been reviewed and no critical issues were found in the content. Nice work.</p>`
      }
      <p style="color: #666; font-size: 12px;">— Report Reviewer</p>
    </div>`;

  let info;
  try {
    info = await transporter.sendMail({
      from: process.env.GMAIL_USER!,
      to: report.studentEmail,
      subject: `Report feedback: ${report.filename}`,
      html,
      attachments,
    });
  } catch (e: any) {
    const code = e?.code || "";
    if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
      throw new Error(
        `SMTP connection failed (${code}). Gmail's submission port may be blocked on this network — try a different network/VPN, or open outbound TCP 587 to smtp.gmail.com.`,
      );
    }
    if (code === "EAUTH") {
      throw new Error(
        "Gmail rejected the credentials. Make sure GMAIL_APP_PASSWORD is a 16-character App Password (not your Google account password) and 2FA is enabled on the account.",
      );
    }
    throw new Error(`Email send failed: ${e?.message || e}`);
  }

  await prisma.report.update({ where: { id: reportId }, data: { status: "SENT" } });
  return { sent: true, count: report.issues.length, messageId: info.messageId };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
