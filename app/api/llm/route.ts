import { NextRequest, NextResponse } from "next/server";
import {
  llmStatus,
  writeRuntimeProvider,
  writeRuntimeModel,
  checkAvailability,
  MODEL_CATALOG,
} from "@/lib/agent/llm/settings";
import type { ProviderName } from "@/lib/agent/llm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isProvider(v: any): v is ProviderName {
  return v === "anthropic" || v === "codex" || v === "gemini";
}

export async function GET() {
  const status = await llmStatus();
  return NextResponse.json(status);
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const provider = String(body?.provider || "").toLowerCase();
  const model = body?.model ? String(body.model) : null;

  if (!isProvider(provider)) {
    return NextResponse.json(
      { error: "provider must be one of: anthropic, codex, gemini" },
      { status: 400 },
    );
  }

  if (model) {
    const allowed = MODEL_CATALOG[provider].some((m) => m.id === model);
    if (!allowed) {
      return NextResponse.json(
        { error: `Model "${model}" not in catalog for ${provider}` },
        { status: 400 },
      );
    }
  }

  // If switching providers, gate by availability. Model-only updates (same
  // provider as current) skip the availability check so users can preselect
  // models for providers they haven't keyed yet.
  const status0 = await llmStatus();
  if (provider !== status0.current) {
    const avail = checkAvailability()[provider];
    if (!avail.available) {
      return NextResponse.json(
        { error: avail.reason || `${provider} not available` },
        { status: 409 },
      );
    }
    await writeRuntimeProvider(provider);
  }

  if (model) await writeRuntimeModel(provider, model);

  const status = await llmStatus();
  return NextResponse.json(status);
}
