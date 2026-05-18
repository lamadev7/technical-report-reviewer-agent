import type { Check, RuleIssue } from "./types";

let spellerPromise: Promise<any> | null = null;

async function loadSpeller(): Promise<any> {
  if (!spellerPromise) {
    spellerPromise = (async () => {
      const [{ default: nspell }, { default: dict }] = await Promise.all([
        import("nspell"),
        import("dictionary-en"),
      ]);
      return nspell(dict);
    })();
  }
  return spellerPromise;
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

function isLikelyProperNoun(token: string, isSentenceStart: boolean): boolean {
  // Skip tokens whose first letter is capital and not at sentence start.
  if (isSentenceStart) return false;
  return /^[A-Z][a-z]+/.test(token);
}

export const spellingCheck: Check = async ({ plainText }) => {
  const speller = await loadSpeller();
  const issues: RuleIssue[] = [];

  const sentences = plainText.split(/(?<=[.!?])\s+/);
  const seen = new Map<string, number>();
  let cursor = 0;

  for (const sentence of sentences) {
    const sentenceStart = plainText.indexOf(sentence, cursor);
    cursor = sentenceStart < 0 ? cursor : sentenceStart + sentence.length;
    const tokens = sentence.match(/\b[A-Za-z][A-Za-z']{2,}\b/g) || [];
    let isFirst = true;
    for (const raw of tokens) {
      const token = raw;
      const lower = token.toLowerCase();
      const wasFirst = isFirst;
      isFirst = false;
      if (lower.length < 4) continue;
      if (SKIP.has(lower)) continue;
      if (/^\d/.test(token)) continue;
      // ALL-CAPS = acronym (RBAC, WebRTC handled too via mixed-case rule below)
      if (/^[A-Z]{2,}$/.test(token)) continue;
      // CamelCase / studlyCaps tokens (e.g. WebRTC, MongoDB) — almost always
      // product/library names that no general dict covers.
      if (/[A-Z]/.test(token.slice(1))) continue;
      if (isLikelyProperNoun(token, wasFirst)) continue;
      if (speller.correct(token)) continue;
      // Report each unique misspelling once — repeats are noise.
      if (seen.has(lower)) continue;
      seen.set(lower, 1);

      const tokenStart = plainText.indexOf(token, sentenceStart >= 0 ? sentenceStart : 0);
      if (tokenStart < 0) continue;
      const suggestions = speller.suggest(token).slice(0, 3);
      issues.push({
        startOffset: tokenStart,
        endOffset: tokenStart + token.length,
        quotedText: token,
        severity: "MAJOR",
        category: "GRAMMAR",
        shortDescription:
          `Likely misspelling: "${token}"` +
          (suggestions.length ? ` — try ${suggestions.join(", ")}` : ""),
      });
      if (issues.length >= 40) return issues;
    }
  }
  return issues;
};
