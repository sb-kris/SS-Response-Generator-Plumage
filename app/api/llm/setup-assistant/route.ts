// Phase 8 — POST /api/llm/setup-assistant
//
// Single non-streaming LLM call that takes the dialog inputs + selected
// survey + (optionally) SS workspace variables, asks the model for a
// JSON brief, validates it, and returns the validated output. The
// client assembles the final SetupAssistantSuggestion (it adds the
// deterministic persona distribution + timing window before showing
// the preview).
//
// Retries: rate-limit retries are handled inside callLLMForJson; we add
// one OPTIONAL "repair" retry if the first validation fails badly
// (no themes returned at all). Keeps the cost bounded — 2 calls max.
//
// SECURITY: API keys come in via the request body, used once per call,
// never logged, never stored.

import { NextResponse, type NextRequest } from "next/server";
import { callLLMForJson } from "@/lib/llm/json-call";
import { callAnthropicWithSearch } from "@/lib/llm/json-call-anthropic-search";
import { buildSetupAssistantPrompt } from "@/lib/llm/prompts/setup-assistant-prompt";
import {
  summarizeSetupErrors,
  validateSetupAssistantOutput,
} from "@/lib/llm/setup-assistant-validator";
import {
  buildResearchBlock,
  fetchCompanyHomepage,
  providerSupportsWebSearch,
} from "@/lib/llm/web-research";
import type {
  SetupAssistantRequest,
  SetupAssistantResponse,
} from "@/lib/generation/setup-assistant-types";
import type { LLMProvider } from "@/lib/llm/models";

export const runtime = "nodejs";
// With Anthropic web_search enabled the model may issue up to 5 search
// queries before producing the JSON, which can push the call to ~45-60s.
// Add the optional repair-retry budget on top and we want ~90s of
// headroom.
export const maxDuration = 90;

const ALLOWED_PROVIDERS: ReadonlySet<LLMProvider> = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "openrouter",
]);

export async function POST(req: NextRequest): Promise<NextResponse<SetupAssistantResponse>> {
  let body: SetupAssistantRequest;
  try {
    body = (await req.json()) as SetupAssistantRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  // ---- Validate inputs ----
  const err = validateRequest(body);
  if (err) {
    return NextResponse.json({ ok: false, error: err }, { status: 400 });
  }

  // ---- Decide the research strategy ----
  //
  // Anthropic users get the model's native web_search tool — the model
  // browses inside the API call. For other providers (OpenAI, Gemini,
  // DeepSeek, Groq, OpenRouter) we fall back to a server-side homepage
  // fetch, which we then inject into the prompt as ground truth.
  //
  // Either path is best-effort: if research fails for any reason, we
  // proceed with whatever we have (the inputs alone are still usable).
  const providerSupportsSearch = providerSupportsWebSearch(body.llm.provider as LLMProvider);
  let researchBlock = "";
  if (!providerSupportsSearch && body.inputs.companyWebsite) {
    const fetched = await fetchCompanyHomepage({
      websiteRaw: body.inputs.companyWebsite,
      signal: req.signal,
    });
    if (fetched.ok && fetched.text) {
      researchBlock = buildResearchBlock(fetched.text, "homepage_fetch");
    }
  }

  // ---- Build the prompt ----
  const prompt = buildSetupAssistantPrompt(body, {
    researchBlock,
    hasWebSearchTool: providerSupportsSearch,
  });

  // ---- First LLM call ----
  let attemptReason: string | undefined;
  const llmConfig = {
    provider: body.llm.provider as LLMProvider,
    apiKey: body.llm.apiKey,
    model: body.llm.model,
    upstreamModelId:
      body.llm.provider === "openrouter" && body.llm.model === "openrouter:custom"
        ? body.llm.customModelId
        : undefined,
    // 4k is plenty for this output — context ~400 chars + 8 themes + 6
    // vars × 6 options = comfortably under 2k tokens. We over-cap to
    // allow a verbose model some headroom.
    maxOutputTokens: 4_000,
    // Bumped from 45s → 70s to allow web_search round-trips on the
    // Anthropic path. Standard JSON-mode calls finish well under this.
    timeoutMs: 70_000,
  };

  // Anthropic gets the search-enabled variant so the model can browse
  // mid-call; every other provider uses the standard JSON-mode call.
  const callLLM = providerSupportsSearch ? callAnthropicWithSearch : callLLMForJson;

  const first = await callLLM({
    ...llmConfig,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    signal: req.signal,
  });

  if (!first.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: first.status,
        error: first.error ?? `LLM call failed (HTTP ${first.status}).`,
      },
      { status: 200 },
    );
  }

  let validation = validateSetupAssistantOutput(first.json);

  // ---- Optional repair retry ----
  // If the first response was structurally broken (e.g. no themes at all),
  // try once more with the validator errors as a repair hint. We do NOT
  // retry on rate limits (callLLMForJson already handles those) or on
  // transport failures.
  if (!validation.ok && validation.output.themes.length === 0) {
    attemptReason = summarizeSetupErrors(validation.errors);
    const repairPrompt = `${prompt.userPrompt}

---
REPAIR ATTEMPT — the previous response failed validation: ${attemptReason}
Re-read the OUTPUT SCHEMA at the top of the system prompt and try again. Return only JSON.`;
    const repair = await callLLM({
      ...llmConfig,
      systemPrompt: prompt.systemPrompt,
      userPrompt: repairPrompt,
      signal: req.signal,
    });
    if (repair.ok) {
      const v2 = validateSetupAssistantOutput(repair.json);
      // Take the repair result only if it's strictly better (more themes).
      if (v2.output.themes.length > validation.output.themes.length) {
        validation = v2;
      }
    }
  }

  // We return the validated output even on a soft fail — the dialog
  // can show whatever the model produced and the user picks.
  const response: SetupAssistantResponse = {
    ok: validation.ok,
    output: validation.output,
    error: validation.ok ? undefined : summarizeSetupErrors(validation.errors),
  };
  return NextResponse.json(response, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateRequest(body: SetupAssistantRequest): string | null {
  if (!body || typeof body !== "object") return "Body is empty.";

  if (!body.inputs || typeof body.inputs !== "object") return "Missing inputs.";
  const i = body.inputs;
  if (!i.companyName || typeof i.companyName !== "string" || !i.companyName.trim()) {
    return "Company name is required.";
  }
  if (
    i.sentimentShape !== "mostly_positive" &&
    i.sentimentShape !== "balanced" &&
    i.sentimentShape !== "recovery" &&
    i.sentimentShape !== "polarized"
  ) {
    return "Sentiment shape is invalid.";
  }

  if (!body.survey || typeof body.survey !== "object") return "Missing survey context.";
  if (!body.survey.name || typeof body.survey.name !== "string") return "Survey name is missing.";
  if (!Array.isArray(body.survey.questions)) return "Survey questions are missing.";

  if (!body.llm || typeof body.llm !== "object") return "Missing LLM credentials.";
  const llm = body.llm;
  if (!llm.provider || !ALLOWED_PROVIDERS.has(llm.provider as LLMProvider)) {
    return "Unsupported LLM provider.";
  }
  if (!llm.apiKey || typeof llm.apiKey !== "string") return "LLM API key is required.";
  if (!llm.model || typeof llm.model !== "string") return "LLM model is required.";
  if (llm.provider === "openrouter" && llm.model === "openrouter:custom" && !llm.customModelId) {
    return "OpenRouter custom model requires customModelId.";
  }

  return null;
}
