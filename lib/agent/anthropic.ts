import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export const MODEL = "claude-sonnet-4-6";
