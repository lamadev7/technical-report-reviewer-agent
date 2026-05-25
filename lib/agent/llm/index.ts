import { readFileSync } from "node:fs";
import path from "node:path";
import type { LlmProvider, ProviderName } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createCodexProvider } from "./codex";
import { createGeminiProvider } from "./gemini";

export type { LlmProvider, LlmJsonRequest, LlmJsonResponse, LlmSegment, ProviderName } from "./types";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
const SETTINGS_PATH = path.join(STORAGE_DIR, "llm-settings.json");

function resolveProviderName(): ProviderName {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const json = JSON.parse(raw);
    const p = json?.provider;
    if (p === "anthropic" || p === "codex" || p === "gemini") return p;
  } catch {
    // fall through to env
  }
  const env = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (env === "anthropic" || env === "codex" || env === "gemini") return env;
  return "anthropic";
}

export function getProvider(): LlmProvider {
  const name = resolveProviderName();
  switch (name) {
    case "anthropic":
      return createAnthropicProvider();
    case "codex":
      return createCodexProvider();
    case "gemini":
      return createGeminiProvider();
  }
}
