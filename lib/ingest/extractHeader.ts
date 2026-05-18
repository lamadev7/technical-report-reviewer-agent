const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
const NAME_LABEL_RE = /(?:^|\n)\s*(?:name|student|author|by)\s*[:\-]\s*([A-Z][A-Za-z'.\- ]{1,60})/i;

export type ExtractedHeader = {
  studentName: string | null;
  studentEmail: string | null;
};

export function extractHeader(plainText: string): ExtractedHeader {
  const head = plainText.slice(0, 2000);
  const emailMatch = head.match(EMAIL_RE);
  const studentEmail = emailMatch ? emailMatch[0] : null;

  let studentName: string | null = null;
  const labeled = head.match(NAME_LABEL_RE);
  if (labeled) {
    studentName = labeled[1].trim();
  } else {
    // Fallback: first non-empty short line that's not the email
    for (const raw of head.split(/\n+/).slice(0, 8)) {
      const line = raw.trim();
      if (!line || line.length > 80 || EMAIL_RE.test(line)) continue;
      if (/^[A-Z][A-Za-z'.\- ]{2,}$/.test(line)) {
        studentName = line;
        break;
      }
    }
  }

  return { studentName, studentEmail };
}
