import { NextResponse, type NextRequest } from "next/server";
import { testProvider } from "@/lib/llm/test-providers";
import {
  getModel,
  getProviderLabel,
  isKnownProvider,
  type LLMProvider,
} from "@/lib/llm/models";

export const runtime = "nodejs";

interface TestRequest {
  provider?: string;
  apiKey?: string;
  model?: string;
  /** OpenRouter only — required when `model` is the `openrouter:custom` sentinel. */
  customModelId?: string;
}

export async function POST(req: NextRequest) {
  let body: TestRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!isKnownProvider(body.provider)) {
    return NextResponse.json(
      { ok: false, error: "Unknown provider. Pick one from the setup screen." },
      { status: 400 },
    );
  }
  const provider = body.provider as LLMProvider;
  if (!body.apiKey) {
    return NextResponse.json({ ok: false, error: "API key is required." }, { status: 400 });
  }
  if (!body.model) {
    return NextResponse.json({ ok: false, error: "Select a model to test." }, { status: 400 });
  }

  const known = getModel(body.model);
  if (!known || known.provider !== provider) {
    return NextResponse.json(
      {
        ok: false,
        error: `Model "${body.model}" is not available for ${getProviderLabel(provider)}.`,
      },
      { status: 400 },
    );
  }

  // OpenRouter sentinel — user picked "Custom model ID" from the dropdown
  // and must supply the actual upstream ID separately.
  let upstreamModelId: string | undefined;
  if (provider === "openrouter" && body.model === "openrouter:custom") {
    const custom = body.customModelId?.trim();
    if (!custom) {
      return NextResponse.json(
        {
          ok: false,
          error: "Enter the OpenRouter model ID you want to test (e.g. anthropic/claude-3.5-haiku).",
        },
        { status: 400 },
      );
    }
    upstreamModelId = custom;
  }

  const result = await testProvider({
    provider,
    apiKey: body.apiKey,
    model: body.model,
    upstreamModelId,
  });

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    error: result.error ?? null,
    sample: result.sample ?? null,
    model: upstreamModelId ?? body.model,
  });
}
