import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderName } from "./types";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
const SETTINGS_PATH = path.join(STORAGE_DIR, "llm-settings.json");

export interface ProviderAvailability {
  available: boolean;
  via: "sdk" | "cli" | "none";
  reason?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

export interface LlmStatus {
  current: ProviderName;
  source: "runtime" | "env" | "default";
  models: Record<ProviderName, string>;
  catalog: Record<ProviderName, ModelOption[]>;
  availability: Record<ProviderName, ProviderAvailability>;
}

interface SettingsFile {
  provider?: ProviderName;
  models?: Partial<Record<ProviderName, string>>;
}

export const MODEL_CATALOG: Record<ProviderName, ModelOption[]> = {
  anthropic: [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", note: "highest quality" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "balanced (default)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "fastest / cheapest" },
  ],
  codex: [
    { id: "gpt-5", label: "GPT-5", note: "needs verified org" },
    { id: "gpt-5-codex", label: "GPT-5 Codex", note: "code-tuned" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5-nano", label: "GPT-5 Nano", note: "cheapest" },
    { id: "o3", label: "o3", note: "reasoning, verified org" },
    { id: "o3-mini", label: "o3-mini", note: "reasoning" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "highest quality" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "balanced (default)" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", note: "cheapest" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
};

const DEFAULTS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  codex: "gpt-5-codex",
  gemini: "gemini-2.5-flash",
};

function envProvider(): ProviderName | null {
  const raw = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (raw === "anthropic" || raw === "codex" || raw === "gemini") return raw;
  return null;
}

function envModel(p: ProviderName): string | null {
  const key = p === "anthropic" ? "ANTHROPIC_MODEL" : p === "codex" ? "OPENAI_MODEL" : "GEMINI_MODEL";
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

function readSettingsSync(): SettingsFile {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function readSettings(): Promise<SettingsFile> {
  try {
    const buf = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

async function writeSettings(s: SettingsFile): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf8");
}

export async function writeRuntimeProvider(provider: ProviderName): Promise<void> {
  const cur = await readSettings();
  await writeSettings({ ...cur, provider });
}

export async function writeRuntimeModel(provider: ProviderName, model: string): Promise<void> {
  const allowed = MODEL_CATALOG[provider].some((m) => m.id === model);
  if (!allowed) throw new Error(`Model "${model}" not in catalog for ${provider}`);
  const cur = await readSettings();
  await writeSettings({ ...cur, models: { ...(cur.models || {}), [provider]: model } });
}

export async function activeProvider(): Promise<{ name: ProviderName; source: "runtime" | "env" | "default" }> {
  const s = await readSettings();
  if (s.provider === "anthropic" || s.provider === "codex" || s.provider === "gemini") {
    return { name: s.provider, source: "runtime" };
  }
  const env = envProvider();
  if (env) return { name: env, source: "env" };
  return { name: "anthropic", source: "default" };
}

export function activeProviderSync(): ProviderName {
  const s = readSettingsSync();
  if (s.provider === "anthropic" || s.provider === "codex" || s.provider === "gemini") return s.provider;
  return envProvider() ?? "anthropic";
}

export async function modelFor(p: ProviderName): Promise<string> {
  const s = await readSettings();
  const fromFile = s.models?.[p];
  if (fromFile && MODEL_CATALOG[p].some((m) => m.id === fromFile)) return fromFile;
  return envModel(p) ?? DEFAULTS[p];
}

export function modelForSync(p: ProviderName): string {
  const s = readSettingsSync();
  const fromFile = s.models?.[p];
  if (fromFile && MODEL_CATALOG[p].some((m) => m.id === fromFile)) return fromFile;
  return envModel(p) ?? DEFAULTS[p];
}

function cliAvailable(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function checkAvailability(): Record<ProviderName, ProviderAvailability> {
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const claudeCli = cliAvailable("claude");
  const openaiKey = !!process.env.OPENAI_API_KEY;
  const geminiKey = !!process.env.GEMINI_API_KEY;

  return {
    anthropic: anthropicKey
      ? { available: true, via: "sdk" }
      : claudeCli
        ? { available: true, via: "cli" }
        : { available: false, via: "none", reason: "ANTHROPIC_API_KEY missing and `claude` CLI not on PATH" },
    codex: openaiKey
      ? { available: true, via: "sdk" }
      : { available: false, via: "none", reason: "OPENAI_API_KEY missing" },
    gemini: geminiKey
      ? { available: true, via: "sdk" }
      : { available: false, via: "none", reason: "GEMINI_API_KEY missing" },
  };
}

export async function llmStatus(): Promise<LlmStatus> {
  const { name, source } = await activeProvider();
  const [anthropicModel, codexModel, geminiModel] = await Promise.all([
    modelFor("anthropic"),
    modelFor("codex"),
    modelFor("gemini"),
  ]);
  return {
    current: name,
    source,
    models: { anthropic: anthropicModel, codex: codexModel, gemini: geminiModel },
    catalog: MODEL_CATALOG,
    availability: checkAvailability(),
  };
}
