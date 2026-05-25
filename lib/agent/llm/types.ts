export type ProviderName = "anthropic" | "codex" | "gemini";

export interface LlmSegment {
  text: string;
  cache?: boolean;
}

// Binary attachment passed alongside the prompt. Used to let multimodal
// providers (Gemini, Anthropic SDK) read PDFs/images directly so the model
// can see image-only sections (scanned declarations, logo blocks) that text
// extraction misses. Providers without multimodal support ignore attachments
// and continue text-only.
export interface LlmAttachment {
  mimeType: string;       // e.g. "application/pdf", "image/png"
  data: Buffer;
  // Human-facing tag, surfaced in prompt when provider can't render the
  // attachment (so the model knows context was attempted).
  description?: string;
}

export interface LlmJsonRequest {
  systemSegments: LlmSegment[];
  userSegments: LlmSegment[];
  attachments?: LlmAttachment[];
  schemaName?: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmJsonResponse {
  json: unknown;
  via: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  generateJson(req: LlmJsonRequest): Promise<LlmJsonResponse>;
}
