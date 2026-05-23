import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
function normalize(s) {
  return s.toLowerCase()
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/[—–-]\s*try\s+[^.]*/g, "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const rows = await p.issue.findMany({
  where: { deleted: true, source: { not: "REVIEWER" } },
  select: { shortDescription: true, quotedText: true, category: true },
});
const map = new Map();
for (const r of rows) {
  const k = normalize(r.shortDescription);
  if (!k) continue;
  const cur = map.get(k) || { count: 0, sampleDesc: r.shortDescription, sampleQuoted: r.quotedText, category: r.category };
  cur.count++;
  map.set(k, cur);
}
console.log("backfilling", map.size, "patterns");
for (const [k, v] of map) {
  await p.learnedRejection.upsert({
    where: { normalizedDesc: k },
    update: { hitCount: v.count },
    create: { normalizedDesc: k, sampleDesc: v.sampleDesc.slice(0, 240), sampleQuoted: v.sampleQuoted.slice(0, 240), category: v.category, hitCount: v.count },
  });
}
const learned = await p.learnedRejection.findMany({ where: { hitCount: { gte: 3 } } });
console.log("learned (>=3 hits):", learned.length);
for (const r of learned) console.log("  ×", r.hitCount, "—", r.sampleDesc.slice(0, 100));
await p.$disconnect();
