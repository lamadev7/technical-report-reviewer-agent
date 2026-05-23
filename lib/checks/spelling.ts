import type { Check, RuleIssue } from "./types";

let spellersPromise: Promise<any[]> | null = null;

async function loadSpellers(): Promise<any[]> {
  if (!spellersPromise) {
    spellersPromise = (async () => {
      const [{ default: nspell }, { default: dictUS }, { default: dictGB }] = await Promise.all([
        import("nspell"),
        import("dictionary-en"),
        import("dictionary-en-gb"),
      ]);
      return [nspell(dictUS), nspell(dictGB)];
    })();
  }
  return spellersPromise;
}

function correctInAnyDict(spellers: any[], token: string): boolean {
  return spellers.some((s) => s.correct(token));
}

function suggestFromAny(spellers: any[], token: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of spellers) {
    for (const sug of s.suggest(token)) {
      if (!seen.has(sug)) {
        seen.add(sug);
        out.push(sug);
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

const SKIP = new Set([
  // technical / web terms commonly missing from generic English dictionaries
  "javascript", "typescript", "json", "api", "apis", "url", "urls", "uri",
  "https", "http", "ui", "ux", "html", "css", "sql", "nosql", "oauth",
  "jwt", "frontend", "backend", "fullstack", "github", "gitlab", "npm",
  "pnpm", "yarn", "nextjs", "reactjs", "nodejs", "postgres", "postgresql",
  "mongodb", "redis", "kafka", "kubernetes", "docker", "linux", "macos",
  "mvp", "saas", "iaas", "paas", "ci", "cd", "qa", "iot", "ml", "ai",
  "scalable", "scalability", "responsive", "responsiveness", "dashboard",
  "dashboards", "username", "usernames", "login", "logout", "signup",
  "signin", "config", "configs", "workflow", "workflows", "lifecycle",
  "lifecycles", "microservice", "microservices", "serverless", "webhook",
  "webhooks", "endpoint", "endpoints", "middleware", "middlewares",
  "runtime", "runtimes", "subnet", "subnets", "stateless", "stateful",
  "cacheable", "cacheing", "dataset", "datasets", "datacenter",
  "balancer", "balancers", "loadbalancer", "sandbox", "sandboxes",
  // academic / report scaffolding
  "abstract", "intro", "methodology", "methodologies", "bibliography",
  "bibliographies", "citation", "citations",
]);

export const spellingCheck: Check = async ({ plainText }) => {
  const spellers = await loadSpellers();
  const issues: RuleIssue[] = [];

  const sentences = plainText.split(/(?<=[.!?])\s+/);
  const seen = new Map<string, number>();
  let cursor = 0;

  for (const sentence of sentences) {
    const sentenceStart = plainText.indexOf(sentence, cursor);
    cursor = sentenceStart < 0 ? cursor : sentenceStart + sentence.length;
    const tokens = sentence.match(/\b[A-Za-z][A-Za-z']{2,}\b/g) || [];
    for (const token of tokens) {
      const lower = token.toLowerCase();
      // Short tokens are mostly PDF-extraction fragments ("nomy" from "astronomy")
      // or unhelpful 4-letter typos that produce more noise than signal.
      if (lower.length < 5) continue;
      if (SKIP.has(lower)) continue;
      if (/^\d/.test(token)) continue;
      // ALL-CAPS = acronym
      if (/^[A-Z]{2,}$/.test(token)) continue;
      // CamelCase / studlyCaps = product/library names
      if (/[A-Z]/.test(token.slice(1))) continue;
      // Any first-letter-cap = treat as proper noun. Trades catching "Recieve"
      // at sentence start for not flagging "Gantt", "Kubernetes", surnames, etc.
      if (/^[A-Z]/.test(token)) continue;
      if (correctInAnyDict(spellers, token)) continue;
      if (seen.has(lower)) continue;
      seen.set(lower, 1);

      const suggestions = suggestFromAny(spellers, token);
      // No plausible suggestion → likely an OCR/PDF fragment, not a misspelling.
      if (suggestions.length === 0) continue;

      const tokenStart = plainText.indexOf(token, sentenceStart >= 0 ? sentenceStart : 0);
      if (tokenStart < 0) continue;
      issues.push({
        startOffset: tokenStart,
        endOffset: tokenStart + token.length,
        quotedText: token,
        severity: "MAJOR",
        category: "GRAMMAR",
        shortDescription: `Likely misspelling: "${token}" — try ${suggestions.join(", ")}`,
      });
      if (issues.length >= 40) return issues;
    }
  }
  return issues;
};
