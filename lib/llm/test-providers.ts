// Thin "is this API key + model valid?" probe — sends a tiny JSON-producing
// prompt through the same dispatcher persona/response generation uses, so a
// successful test is a real end-to-end smoke check that:
//   1) the key is accepted,
//   2) the selected model exists for this account,
//   3) the provider's JSON-output mode actually returns parseable JSON.
//
// Cost is negligible: prompt is ~30 input tokens, response is capped at 32
// output tokens. Multiply across the cheapest models and you're at fractions
// of a cent.

import type { LLMProvider } from "./models";
import { callLLMForJson } from "./json-call";
import { getProviderLabel } from "./models";

export interface ProviderTestInput {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** OpenRouter-only — the actual upstream model ID when the user picked
   *  the "Custom model ID" sentinel. */
  upstreamModelId?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number;
  error?: string;
  /** Plain text the model echoed back (for sanity checking). */
  sample?: string;
}

const PROBE_SYSTEM =
  "You are a connectivity probe. Reply with strict JSON only. No markdown.";
const PROBE_USER =
  'Return exactly this JSON: {"ok":true,"echo":"plumage"}';
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_TOKENS = 32;

export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
  if (!input.apiKey) {
    return { ok: false, status: 0, error: "Missing API key" };
  }
  if (!input.model) {
    return { ok: false, status: 0, error: "Missing model" };
  }

  const result = await callLLMForJson({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    upstreamModelId: input.upstreamModelId,
    systemPrompt: PROBE_SYSTEM,
    userPrompt: PROBE_USER,
    maxOutputTokens: PROBE_MAX_TOKENS,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error ?? defaultErrorFor(input.provider, result.status),
    };
  }

  // The probe should round-trip a `{"ok":true,...}` JSON object. We don't
  // require an exact match — different providers shape their JSON output
  // slightly differently, and we just want a sanity check that the model
  // returned something parseable.
  const sample = summarizeJson(result.json);
  return { ok: true, status: result.status, sample };
}

function summarizeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  } catch {
    return String(value);
  }
}

function defaultErrorFor(provider: LLMProvider, status: number): string {
  const label = getProviderLabel(provider);
  switch (status) {
    case 0:
      return `Network error contacting ${label}.`;
    case 401:
      return `${label} returned 401: invalid API key.`;
    case 403:
      return `${label} returned 403: key lacks permission for this model.`;
    case 404:
      return `${label} returned 404: model not found for this account.`;
    case 429:
      return `${label} returned 429: rate limit exceeded.`;
    default:
      return `${label} returned HTTP ${status}.`;
  }
}
