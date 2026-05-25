import OpenAI from "openai";
import type { LlmProvider, LlmJsonRequest, LlmJsonResponse } from "./types";
import { modelFor } from "./settings";
import { salvageTruncatedJson } from "./jsonSalvage";

let client: OpenAI | null = null;
function sdk(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// Reasoning-family models (gpt-5*, o-series) require max_completion_tokens
// instead of max_tokens, may not support custom temperature/top_p, and burn
// budget on internal reasoning the same way Gemini 2.5 burns thinking tokens.
function isReasoning(model: string): boolean {
  return /^gpt-5/.test(model) || /^o\d/.test(model);
}

export function createCodexProvider(): LlmProvider {
  return {
    name: "codex",
    async generateJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
      const system = req.systemSegments.map((s) => s.text).join("\n\n");
      const user = req.userSegments.map((s) => s.text).join("\n\n");
      const model = await modelFor("codex");
      // Floor at 8k so review (default 8k) and marking (default 1.5k) both
      // get enough headroom; reasoning models also need extra for internal
      // reasoning tokens.
      const tokens = Math.max(req.maxTokens ?? 8000, isReasoning(model) ? 8000 : 4000);

      const params: any = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      };
      if (isReasoning(model)) {
        // max_tokens is deprecated for the reasoning family; the SDK rejects
        // it on some models. max_completion_tokens covers both visible and
        // reasoning tokens.
        params.max_completion_tokens = tokens;
        // Low reasoning effort leaves more budget for the structured output.
        params.reasoning_effort = "low";
      } else {
        params.max_tokens = tokens;
      }

      const resp = await sdk().chat.completions.create(params, { signal: req.signal });
      const choice = resp.choices[0];
      const text = choice?.message?.content;
      const finishReason = choice?.finish_reason;

      if (!text) {
        throw new Error(
          `OpenAI returned empty content (finish_reason=${finishReason || "unknown"}, model=${model})`,
        );
      }

      try {
        return { json: JSON.parse(text), via: "codex-sdk" };
      } catch (e: any) {
        if (finishReason === "length") {
          const salvaged = salvageTruncatedJson(text);
          if (salvaged !== null) {
            return { json: salvaged, via: "codex-sdk(salvaged)" };
          }
        }
        throw new Error(
          `OpenAI JSON parse failed (finish_reason=${finishReason || "unknown"}, model=${model}): ${e.message}. Head: ${text.slice(0, 400)}`,
        );
      }
    },
  };
}
