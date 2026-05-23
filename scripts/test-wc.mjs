import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
function isTocLine(line) { return /(?:[.…·\-_\t]{3,}|\s{4,})\s*\d{1,4}\s*$/.test(line); }
function findHeadingOffsets(plain, re) {
  const out = [];
  const lines = plain.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (re.test(line) && !isTocLine(line)) out.push(offset);
    offset += line.length + 1;
  }
  return out;
}
function majorContentText(plain) {
  const introRe = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?introduction\s*$/i;
  const conclRe = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?conclusions?\s*$/i;
  const i = findHeadingOffsets(plain, introRe);
  const c = findHeadingOffsets(plain, conclRe);
  let start = 0, end = plain.length;
  if (i.length) start = i[0];
  if (c.length) { const a = c.find(o => o > start); if (a !== undefined) end = a; }
  let text = plain.slice(start, end);
  return text.split("\n").filter(l => !/^\s*([\-*•]|\d+\.)\s+/.test(l)).join("\n");
}
function count(s) { return (s.match(/\b[\p{L}\p{N}']+\b/gu) || []).length; }
const r = await p.report.findUnique({ where: { id: "cmpa0i4xy0002rq73j8ichpth" }, select: { plainText: true }});
const txt = majorContentText(r.plainText);
console.log("major content chars:", txt.length, "words:", count(txt));
console.log("preview start:", txt.slice(0, 300));
console.log("preview end:  ", txt.slice(-300));
await p.$disconnect();
