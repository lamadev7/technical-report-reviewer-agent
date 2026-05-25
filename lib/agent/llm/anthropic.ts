import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCliJson, claudeCliAvailable } from "../cli";
import type { LlmProvider, LlmJsonRequest, LlmJsonResponse } from "./types";
import { modelFor } from "./settings";

let client: Anthropic | null = null;
function sdk(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return client;
}

export function createAnthropicProvider(): LlmProvider {
  return {
    name: "anthropic",
    async generateJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
      const useCli = !process.env.ANTHROPIC_API_KEY;

      if (!useCli) {
        const toolName = req.schemaName || "submit_result";
        const tool = {
          name: toolName,
          description: "Return the structured result for this request.",
          input_schema: req.schema || { type: "object", properties: {} },
        };
        const systemBlocks = req.systemSegments.map((seg) =>
          seg.cache
            ? { type: "text" as const, text: seg.text, cache_control: { type: "ephemeral" as const } }
            : { type: "text" as const, text: seg.text },
        );
        const userBlocks: any[] = [];
        // Attachments first (PDFs / images) so the model has visual context
        // before reading the textual user content. Anthropic accepts
        // `document` blocks for PDFs and `image` blocks for image attachments.
        if (req.attachments) {
          for (const att of req.attachments) {
            if (att.mimeType === "application/pdf") {
              userBlocks.push({
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: att.data.toString("base64"),
                },
              });
            } else if (att.mimeType.startsWith("image/")) {
              userBlocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: att.mimeType,
                  data: att.data.toString("base64"),
                },
              });
            }
          }
        }
        for (const seg of req.userSegments) {
          userBlocks.push(
            seg.cache
              ? { type: "text" as const, text: seg.text, cache_control: { type: "ephemeral" as const } }
              : { type: "text" as const, text: seg.text },
          );
        }
        const msg = await sdk().messages.create(
          {
            model: await modelFor("anthropic"),
            max_tokens: req.maxTokens ?? 4000,
            system: systemBlocks,
            tools: [tool as any],
            tool_choice: { type: "tool", name: toolName },
            messages: [{ role: "user", content: userBlocks }],
          },
          { signal: req.signal },
        );
        const block = msg.content.find((b) => b.type === "tool_use");
        if (!block || block.type !== "tool_use") {
          throw new Error("Anthropic SDK: model did not call the structured-output tool");
        }
        return { json: block.input, via: "anthropic-sdk" };
      }

      if (!claudeCliAvailable()) {
        throw new Error(
          "ANTHROPIC_API_KEY not set and `claude` CLI not found on PATH. Install Claude Code CLI or set ANTHROPIC_API_KEY in .env.",
        );
      }
      const systemPrompt = req.systemSegments
        .map((s) => s.text)
        .concat("Output format: JSON only matching the provided schema. Do not call any tools.")
        .join("\n\n");
      const userPrompt = req.userSegments
        .map((s) => s.text)
        .concat("Return JSON only. No prose, no markdown fences.")
        .join("\n\n");
      const json = await runClaudeCliJson({
        systemPrompt,
        userPrompt,
        jsonSchema: req.schema,
        model: await modelFor("anthropic"),
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      return { json, via: "anthropic-cli" };
    },
  };
}
