import { spawn } from "node:child_process";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export class ClaudeCliError extends Error {
  constructor(msg: string, public stderr?: string) {
    super(msg);
  }
}

/**
 * Invoke the `claude` CLI in non-interactive mode and return parsed JSON output.
 * Used as a fallback when ANTHROPIC_API_KEY is not set — leverages the user's
 * existing Claude Code session credentials.
 */
export function runClaudeCliJson<T = unknown>({
  systemPrompt,
  userPrompt,
  jsonSchema,
  model = DEFAULT_MODEL,
  timeoutMs = 540_000,
}: {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema?: object;
  model?: string;
  timeoutMs?: number;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", userPrompt,
      "--system-prompt", systemPrompt,
      "--output-format", "json",
      "--model", model,
      // Do NOT pass --bare: it forces ANTHROPIC_API_KEY-only auth and skips
      // OAuth/keychain, defeating the CLI-fallback path (which runs precisely
      // when ANTHROPIC_API_KEY is unset).
      // Override user settings to disable plugins/skills/hooks so things like
      // the caveman session-start hook can't hijack output formatting.
      "--settings", JSON.stringify({ enabledPlugins: {}, hooks: {} }),
      "--disable-slash-commands",
      "--no-session-persistence",
      "--tools", "",
    ];
    // NOTE: do NOT pass `--json-schema`. With Claude CLI 2.x it triggers a
    // second internal turn that empties the result text. The schema is
    // already enforced downstream by Zod (see reviewer.ts).
    void jsonSchema;

    // Run from /tmp so the CLI does not auto-discover the project's CLAUDE.md
    // / AGENTS.md and load them into the system prompt (we provide our own).
    const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: "/tmp" });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new ClaudeCliError(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`claude CLI spawn failed: ${e.message}`, err));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // claude CLI emits its JSON envelope on stderr when exit != 0; check both streams.
      const text = out.trim() || err.trim();
      let envelope: any = null;
      try { envelope = JSON.parse(text); } catch {}

      if (envelope && envelope.is_error === true) {
        const msg = typeof envelope.result === "string" ? envelope.result : `claude CLI error (exit ${code})`;
        if (/not logged in/i.test(msg)) {
          return reject(new ClaudeCliError(`Claude CLI is not logged in. Run \`claude /login\` once in a terminal to authenticate, then retry. (Or set ANTHROPIC_API_KEY in .env to use the SDK instead.)`, text));
        }
        return reject(new ClaudeCliError(`claude CLI: ${msg}`, text));
      }

      if (code !== 0) {
        return reject(new ClaudeCliError(`claude CLI exit ${code}`, text));
      }

      try {
        const raw = envelope?.result ?? envelope;
        if (typeof raw === "string") {
          const stripped = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```\s*$/i, "")
            .trim();
          resolve(JSON.parse(stripped) as T);
        } else {
          resolve(raw as T);
        }
      } catch (e: any) {
        reject(
          new ClaudeCliError(
            `claude CLI output parse failed: ${e.message}. Output head: ${text.slice(0, 400)}`,
            err,
          ),
        );
      }
    });
  });
}

export function claudeCliAvailable(): boolean {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
