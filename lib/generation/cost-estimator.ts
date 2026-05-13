// Pure cost + time estimator for the Plumage generation pipeline.
//
// All estimates include a 15% buffer for retries and variability.
//
// Pricing is sourced from `lib/llm/pricing.ts`. If a model has no pricing
// entry, the estimator still returns a valid `CostEstimate` — costs for the
// affected phase(s) are 0 and `unknownPricing` is true with a per-phase
// warning. The UI surfaces "Pricing unavailable" instead of a fake number.

import { MODEL_PRICING } from "@/lib/llm/pricing";
import { getModel, getProviderConcurrency, type LLMProvider } from "@/lib/llm/models";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostEstimateInput {
  responseCount: number;
  /** Answerable question count (from the survey). */
  questionCount: number;
  personaModelId: string;
  responseModelId: string;
  /** 0–1: proportion of personas assigned to non-English languages. */
  nonEnglishFraction: number;
  /** Explicit provider override for concurrency / speed assumptions. If
   *  omitted, both phases use the persona model's provider — fine when both
   *  models share a provider. */
  provider?: LLMProvider;
}

export interface PhaseEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cost including the 15% buffer, in USD. `null` when pricing is unknown. */
  cost: number | null;
  /** True if pricing was missing for this phase's model. */
  unknownPricing: boolean;
  /** The model ID this phase used — handy for UI labels. */
  modelId: string;
}

export interface CostEstimate {
  persona: PhaseEstimate;
  response: PhaseEstimate;
  /** Total of phases with known pricing. `null` when ANY phase is unknown
   *  AND we can't fall back to a partial sum. */
  totalCost: number | null;
  /** True if either phase had unknown pricing. */
  unknownPricing: boolean;
  /** Human-readable warnings for the UI ("Pricing unavailable for X"). */
  pricingWarnings: string[];
  /** Total wall-clock seconds including 15% buffer. */
  totalSeconds: number;
  // Details exposed for the "How is this calculated?" breakdown.
  surveyContextTokens: number;
  nonEnglishMultiplier: number;
  batchCount: number;
  bufferFactor: 1.15;
  /** Effective response-phase concurrency used in the time math. Surfaced
   *  so the UI breakdown can show "8× parallel calls" etc. */
  responseConcurrency: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Approximate output tokens / second per model (output dominates latency).
// When a model isn't listed, we fall back to PROVIDER_DEFAULT_SPEED below.
const MODEL_SPEED_TPS: Record<string, number> = {
  // Anthropic
  "claude-haiku-4-5-20251001": 150_000,
  "claude-sonnet-4-6": 50_000,
  "claude-opus-4-7": 20_000,
  // OpenAI
  "gpt-4o-mini": 120_000,
  "gpt-4o": 40_000,
  "gpt-4.1-mini": 130_000,
  "gpt-4.1-nano": 200_000,
  "gpt-5-mini": 90_000,
  "gpt-5-nano": 180_000,
  // Google
  "gemini-2.5-flash-lite": 250_000,
  "gemini-2.5-flash": 150_000,
  "gemini-2.5-pro": 50_000,
  // DeepSeek
  "deepseek-chat": 80_000,
  "deepseek-reasoner": 30_000,
  // Groq — extremely fast at output token rate
  "openai/gpt-oss-120b": 350_000,
  "openai/gpt-oss-20b": 500_000,
  "llama-3.3-70b-versatile": 400_000,
  "llama-3.1-8b-instant": 750_000,
};

const PROVIDER_DEFAULT_SPEED: Record<LLMProvider, number> = {
  anthropic: 50_000,
  openai: 60_000,
  google: 150_000,
  deepseek: 60_000,
  groq: 350_000,
  openrouter: 60_000,
};

const BUFFER = 1.15;

// ---------------------------------------------------------------------------
// Core estimator
// ---------------------------------------------------------------------------

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const N = Math.max(1, Math.round(input.responseCount));
  const Q = Math.max(0, Math.round(input.questionCount));

  const personaModel = getModel(input.personaModelId);
  const responseModel = getModel(input.responseModelId);
  const personaProvider: LLMProvider | undefined =
    input.provider ?? personaModel?.provider;
  const responseProvider: LLMProvider | undefined =
    input.provider ?? responseModel?.provider;

  const personaPricing = MODEL_PRICING[input.personaModelId];
  const responsePricing = MODEL_PRICING[input.responseModelId];

  // ---- Persona phase -------------------------------------------------------
  // Batched 10 personas per LLM call (matches persona-synthesizer.ts):
  //   input  = ceil(N/10) × 800 (system) + N × 4 (persona seed tokens)
  //   output = N × 120
  const batchCount = Math.ceil(N / 10);
  const personaInputTokens = batchCount * 800 + N * 4;
  const personaOutputTokens = N * 120;
  const personaPhase = priceTokens({
    modelId: input.personaModelId,
    pricing: personaPricing ?? null,
    inputTokens: personaInputTokens,
    outputTokens: personaOutputTokens,
  });

  // ---- Response phase ------------------------------------------------------
  // One call per persona, all questions answered at once:
  //   survey_context = Q × 40 + 200
  //   input_per_response  = 400 (system + persona profile) + survey_context
  //   output_per_response = Q × 60
  // Non-English responses use ~25% more tokens on average.
  const surveyContextTokens = Q * 40 + 200;
  const inputPerResponse = 400 + surveyContextTokens;
  const outputPerResponse = Q * 60;
  const nonEnglishMultiplier =
    1 + Math.max(0, Math.min(1, input.nonEnglishFraction)) * 0.25;
  const responseInputTokens = N * inputPerResponse * nonEnglishMultiplier;
  const responseOutputTokens = N * outputPerResponse * nonEnglishMultiplier;
  const responsePhase = priceTokens({
    modelId: input.responseModelId,
    pricing: responsePricing ?? null,
    inputTokens: responseInputTokens,
    outputTokens: responseOutputTokens,
  });

  // ---- Time ----------------------------------------------------------------
  const personaSpeed =
    MODEL_SPEED_TPS[input.personaModelId] ??
    (personaProvider ? PROVIDER_DEFAULT_SPEED[personaProvider] : 50_000);
  const responseSpeed =
    MODEL_SPEED_TPS[input.responseModelId] ??
    (responseProvider ? PROVIDER_DEFAULT_SPEED[responseProvider] : 50_000);
  const responseConcurrency = responseProvider
    ? getProviderConcurrency(responseProvider, input.responseModelId)
    : 5;
  const personaSeconds = (personaInputTokens + personaOutputTokens) / personaSpeed;
  const responseSeconds =
    (responseInputTokens + responseOutputTokens) /
    responseSpeed /
    Math.max(1, responseConcurrency);
  const rawTotalSeconds = personaSeconds + responseSeconds;

  // ---- Total + warnings ----------------------------------------------------
  const pricingWarnings: string[] = [];
  if (personaPhase.unknownPricing) {
    pricingWarnings.push(`Pricing unavailable for persona model (${input.personaModelId}).`);
  }
  if (responsePhase.unknownPricing) {
    pricingWarnings.push(`Pricing unavailable for response model (${input.responseModelId}).`);
  }
  const unknownPricing = personaPhase.unknownPricing || responsePhase.unknownPricing;
  const totalCost = computeTotal(personaPhase.cost, responsePhase.cost);

  return {
    persona: personaPhase,
    response: responsePhase,
    totalCost,
    unknownPricing,
    pricingWarnings,
    totalSeconds: rawTotalSeconds * BUFFER,
    surveyContextTokens,
    nonEnglishMultiplier,
    batchCount,
    bufferFactor: 1.15,
    responseConcurrency,
  };
}

interface PriceTokensInput {
  modelId: string;
  pricing: { inputPerMTokUsd: number; outputPerMTokUsd: number } | null;
  inputTokens: number;
  outputTokens: number;
}

function priceTokens(input: PriceTokensInput): PhaseEstimate {
  const inputTokensR = Math.round(input.inputTokens);
  const outputTokensR = Math.round(input.outputTokens);
  if (!input.pricing) {
    return {
      inputTokens: inputTokensR,
      outputTokens: outputTokensR,
      totalTokens: inputTokensR + outputTokensR,
      cost: null,
      unknownPricing: true,
      modelId: input.modelId,
    };
  }
  const raw =
    (input.inputTokens / 1_000_000) * input.pricing.inputPerMTokUsd +
    (input.outputTokens / 1_000_000) * input.pricing.outputPerMTokUsd;
  return {
    inputTokens: inputTokensR,
    outputTokens: outputTokensR,
    totalTokens: inputTokensR + outputTokensR,
    cost: raw * BUFFER,
    unknownPricing: false,
    modelId: input.modelId,
  };
}

function computeTotal(a: number | null, b: number | null): number | null {
  // If BOTH phases are unknown, the total is unknown.
  // If EITHER phase has a number, the total is at-minimum that number — we
  // surface the partial sum and let the UI label it accordingly.
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// ---------------------------------------------------------------------------
// Alternative-cost comparisons
// ---------------------------------------------------------------------------

export interface AlternativeCost {
  /** Friendly label, e.g. "Economy", "Premium". */
  label: string;
  personaModelId: string;
  responseModelId: string;
  estimate: CostEstimate;
}

/**
 * Re-run the estimator against a list of alternative (persona, response)
 * pairs. Used by the cost panel to show "Economy would cost ~$0.80" hints.
 * Unknown-pricing alternatives are filtered out so we don't show "?" rows.
 */
export function computeAlternativeCosts(
  input: CostEstimateInput,
  candidates: Array<{ label: string; personaModelId: string; responseModelId: string }>,
): AlternativeCost[] {
  return candidates
    .map((c) => {
      const estimate = estimateCost({
        ...input,
        personaModelId: c.personaModelId,
        responseModelId: c.responseModelId,
      });
      return {
        label: c.label,
        personaModelId: c.personaModelId,
        responseModelId: c.responseModelId,
        estimate,
      };
    })
    .filter((c) => !c.estimate.unknownPricing && c.estimate.totalCost !== null);
}

/** Curated comparison set — economy / balanced / premium. Tuned to be cheap
 *  and quick: only one provider's models per row, so a user without an
 *  Anthropic key can still see a Google Gemini economy quote. */
export const STANDARD_ALTERNATIVE_PAIRS: Array<{
  label: string;
  personaModelId: string;
  responseModelId: string;
}> = [
  {
    label: "Economy (Gemini Flash-Lite)",
    personaModelId: "gemini-2.5-flash-lite",
    responseModelId: "gemini-2.5-flash-lite",
  },
  {
    label: "Balanced (Haiku + Sonnet)",
    personaModelId: "claude-haiku-4-5-20251001",
    responseModelId: "claude-sonnet-4-6",
  },
  {
    label: "Premium (Sonnet + Opus)",
    personaModelId: "claude-sonnet-4-6",
    responseModelId: "claude-opus-4-7",
  },
];

// ---------------------------------------------------------------------------
// Smart suggestion
// ---------------------------------------------------------------------------

export interface CostSuggestion {
  icon: "tip" | "ok" | "warn";
  text: string;
}

export function computeSuggestion(
  estimate: CostEstimate,
  input: CostEstimateInput,
): CostSuggestion | null {
  const { responseModelId, personaModelId, responseCount } = input;

  // If pricing is unknown, suggest moving to a verified model.
  if (estimate.unknownPricing) {
    return {
      icon: "warn",
      text: "Pricing isn't verified for one of the selected models. Cost estimates are skipped for that phase — consider switching to a model with verified pricing.",
    };
  }

  const isSonnet = responseModelId.includes("sonnet");
  const isOpus = responseModelId.includes("opus");

  // Sonnet + high volume → suggest the matching cheaper option.
  if (isSonnet && responseCount >= 500 && estimate.totalCost !== null) {
    const personaModel = getModel(personaModelId);
    const altId = personaModel?.provider === "anthropic"
      ? "claude-haiku-4-5-20251001"
      : "gpt-4o-mini";
    const alt = estimateCost({ ...input, responseModelId: altId });
    if (alt.totalCost !== null) {
      const delta = estimate.totalCost - alt.totalCost;
      const pct = Math.round((delta / estimate.totalCost) * 100);
      const altLabel = altId.includes("haiku") ? "Haiku" : "GPT-4o Mini";
      if (delta > 0) {
        return {
          icon: "tip",
          text: `Using ${altLabel} for responses saves ${formatUsd(delta)} (${pct}% cheaper) with slightly less nuanced text.`,
        };
      }
    }
  }

  // Opus → suggest Sonnet
  if (isOpus && estimate.totalCost !== null) {
    const alt = estimateCost({ ...input, responseModelId: "claude-sonnet-4-6" });
    if (alt.totalCost !== null) {
      const delta = estimate.totalCost - alt.totalCost;
      return {
        icon: "tip",
        text: `Opus is premium quality but ${formatUsd(delta)} more than Sonnet. For most demos, Sonnet is indistinguishable.`,
      };
    }
  }

  // Very high volume
  if (responseCount >= 2000) {
    return {
      icon: "warn",
      text: "Consider generating 500 responses first to validate quality, then generate the remainder.",
    };
  }

  // Already using a cheap configuration.
  const personaCost =
    MODEL_PRICING[personaModelId]?.outputPerMTokUsd ?? Number.POSITIVE_INFINITY;
  const responseCost =
    MODEL_PRICING[responseModelId]?.outputPerMTokUsd ?? Number.POSITIVE_INFINITY;
  if (personaCost <= 0.8 && responseCost <= 0.8) {
    return { icon: "ok", text: "You're using a cost-efficient configuration." };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (exported so the component can use them)
// ---------------------------------------------------------------------------

export function formatUsd(amount: number | null): string {
  if (amount === null) return "—";
  if (amount < 0.005) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

export function formatMinutes(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 1) return "< 1 min";
  if (minutes === 1) return "~1 min";
  return `~${minutes} min`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
