import { GoogleGenAI } from "@google/genai";
import type { LlmProvider, LlmJsonRequest, LlmJsonResponse } from "./types";
import { modelFor } from "./settings";
import { salvageTruncatedJson } from "./jsonSalvage";

let client: GoogleGenAI | null = null;
function sdk(): GoogleGenAI {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// 2.5-Flash/Pro burn output budget on internal "thinking" tokens before
// emitting visible JSON. That truncates mid-string under our 4-8k cap. We
// disable the thinking budget so the full max_output_tokens is available
// for the response body. (2.5-Pro ignores thinkingBudget=0 and uses
// minimum thinking; we set a small budget there.)
function thinkingBudgetFor(model: string): number {
  if (model.includes("2.5-pro")) return 256;
  return 0;
}

export function createGeminiProvider(): LlmProvider {
  return {
    name: "gemini",
    async generateJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
      const system = req.systemSegments.map((s) => s.text).join("\n\n");
      const user = req.userSegments.map((s) => s.text).join("\n\n");
      const model = await modelFor("gemini");

      const config: Record<string, unknown> = {
        systemInstruction: system,
        responseMimeType: "application/json",
        // Gemini supports up to 64k output for 2.5 family; cap our default at
        // 16k so review outputs don't truncate. Caller can still raise.
        maxOutputTokens: Math.max(req.maxTokens ?? 8000, 8000),
        thinkingConfig: { thinkingBudget: thinkingBudgetFor(model) },
      };
      const cleaned = req.schema ? stripUnsupported(req.schema) : null;
      if (cleaned) config.responseSchema = cleaned;

      const abortPromise = req.signal
        ? new Promise<never>((_, reject) => {
            if (req.signal!.aborted) reject(new Error("gemini cancelled"));
            req.signal!.addEventListener(
              "abort",
              () => reject(new Error("gemini cancelled")),
              { once: true },
            );
          })
        : null;

      // Multimodal parts: prepend any attachments (PDFs, images) as inlineData
      // so the model sees scanned/image-only sections that text extraction
      // misses (declaration sheets, logo blocks, signature pages).
      const parts: any[] = [];
      if (req.attachments) {
        for (const att of req.attachments) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.data.toString("base64"),
            },
          });
        }
      }
      parts.push({ text: user });

      const callPromise = sdk().models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: config as any,
      });

      const resp = abortPromise
        ? await Promise.race([callPromise, abortPromise])
        : await callPromise;

      const finishReason = (resp as any)?.candidates?.[0]?.finishReason;
      const text = (resp as any).text as string | undefined;

      if (!text) {
        const safetyBlock = (resp as any)?.candidates?.[0]?.safetyRatings;
        throw new Error(
          `gemini returned empty text (finishReason=${finishReason || "unknown"}${
            safetyBlock ? `, safety=${JSON.stringify(safetyBlock)}` : ""
          })`,
        );
      }

      // Try strict parse first.
      try {
        return { json: JSON.parse(text), via: "gemini-sdk" };
      } catch (e: any) {
        // Salvage path: model hit MAX_TOKENS mid-output. Truncate to the last
        // complete element and try again. Preserves partial results instead
        // of failing the whole review.
        if (finishReason === "MAX_TOKENS") {
          const salvaged = salvageTruncatedJson(text);
          if (salvaged !== null) {
            return { json: salvaged, via: "gemini-sdk(salvaged)" };
          }
        }
        throw new Error(
          `gemini JSON parse failed (finishReason=${finishReason || "unknown"}): ${e.message}. Head: ${text.slice(0, 400)}`,
        );
      }
    },
  };
}

// Gemini's responseSchema accepts an OpenAPI-style subset; drop fields the
// Anthropic tool schemas use that Gemini doesn't.
function stripUnsupported(schema: any): any {
  if (Array.isArray(schema)) return schema.map(stripUnsupported);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "additionalProperties" || k === "$ref") continue;
    out[k] = stripUnsupported(v);
  }
  return out;
}

