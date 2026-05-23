// Provider + model registry — the single source of truth.
//
// Goals:
//   1) Centralize anything that varies per provider/model — labels, tooltips,
//      cost/quality/speed tiers, risk notes, recommended defaults, API-key
//      hints, default concurrency. UI components must NOT hard-code these.
//   2) Make adding a new provider a single-file change.
//   3) Tolerate unknown pricing — if `lib/llm/pricing.ts` doesn't know a
//      model, downstream code (estimator, UI) handles it gracefully.
//
// When you add a model:
//   - Set `recommendedFor` to the kinds (`personas` / `responses`) where this
//     model is a solid default. The UI surfaces a "Recommended" badge.
//   - Set `defaultForPersona`/`defaultForResponse` on EXACTLY ONE model per
//     provider per kind — the first one wins if there's a tie. This is what
//     `getProviderDefaultModels()` returns when the user picks the provider.
//   - Set `mode` to the category surfaced in the UI badge — "economy",
//     "balanced", "premium", "ultra_low_cost", "fast_preview", or "advanced".
//   - Set `riskLevel` honestly. Anything below `business_safe` triggers a
//     warning under the API-key input.
//
// Backward compat with the old, narrower shape is preserved through
// `getModelsForProvider` and `getDefaultModel`.

import { hasPricing, type ModelPricing as RawModelPricing } from "./pricing";

// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "openrouter",
] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];

export function isKnownProvider(value: unknown): value is LLMProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Mode / quality / cost / speed / risk metadata
// ---------------------------------------------------------------------------

export type ModelMode =
  | "economy"
  | "balanced"
  | "premium"
  | "ultra_low_cost"
  | "fast_preview"
  | "advanced";

export type QualityTier = "basic" | "good" | "strong" | "premium";

export type CostTier =
  | "free_or_trial"
  | "very_low"
  | "low"
  | "medium"
  | "high"
  | "premium";

export type SpeedTier = "very_fast" | "fast" | "medium" | "slow";

/** What we promise SEs about data handling for a given provider/model.
 *
 *  - `enterprise_safe`:        usable for any demo; provider has strong DPA/ZDR options.
 *  - `business_safe`:          usable for normal customer-facing prep work.
 *  - `internal_demo_only`:     non-confidential context only; OK for generic demo data.
 *  - `experimental`:           ad-hoc / hobby providers; never paste sensitive context.
 */
export type RiskLevel =
  | "enterprise_safe"
  | "business_safe"
  | "internal_demo_only"
  | "experimental";

export const MODE_LABELS: Record<ModelMode, string> = {
  economy: "Economy",
  balanced: "Balanced",
  premium: "Premium",
  ultra_low_cost: "Ultra low cost",
  fast_preview: "Fast preview",
  advanced: "Advanced",
};

export const COST_TIER_LABELS: Record<CostTier, string> = {
  free_or_trial: "Free / trial",
  very_low: "Very low cost",
  low: "Low cost",
  medium: "Medium cost",
  high: "High cost",
  premium: "Premium cost",
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  enterprise_safe: "Enterprise-safe",
  business_safe: "Business-safe",
  internal_demo_only: "Internal demo only",
  experimental: "Experimental",
};

// ---------------------------------------------------------------------------
// ModelOption — the extended shape
// ---------------------------------------------------------------------------

export interface ModelOption {
  id: string;
  provider: LLMProvider;
  label: string;
  /** Short one-liner shown next to the model name. */
  tagline: string;
  /** Long-form tooltip shown on hover. Should mention recommended use + risk. */
  tooltip: string;
  recommendedFor: ("personas" | "responses")[];
  mode: ModelMode;
  qualityTier: QualityTier;
  costTier: CostTier;
  speedTier: SpeedTier;
  riskLevel: RiskLevel;
  supportsJson: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  defaultForPersona?: boolean;
  defaultForResponse?: boolean;
  deprecated?: boolean;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Provider-level metadata
// ---------------------------------------------------------------------------

export interface ProviderMeta {
  id: LLMProvider;
  label: string;
  /** One-liner for provider cards in the UI. */
  blurb: string;
  /** Hint shown under the API-key input. */
  apiKeyHint: string;
  /** Default concurrency for ALL kinds, used by the synthesizer/responder
   *  if no per-(provider, kind) override is set. */
  defaultConcurrency: number;
  /** Risk note shown under the API-key input. Optional — only set for
   *  providers SEs need to handle carefully. */
  riskNote?: string;
  /** When true, the provider has known data-retention quirks worth surfacing
   *  to the user. The setup card shows this as an extra line. */
  freeTierWarning?: string;
  /** True if model IDs for this provider are open-ended (e.g. OpenRouter
   *  accepts any model the user types). The UI swaps in a Combobox + free-
   *  form input instead of a fixed dropdown. */
  allowsCustomModelId: boolean;
  /** Used by the Setup card to render a high-contrast accent. */
  accentClass: string;
}

const PROVIDER_META: Record<LLMProvider, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Premium quality for polished demo data.",
    apiKeyHint: "Find this at console.anthropic.com → Settings → API keys.",
    defaultConcurrency: 8,
    allowsCustomModelId: false,
    accentClass: "text-orange-600",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    blurb: "Reliable general-purpose generation.",
    apiKeyHint: "Find this at platform.openai.com → API keys.",
    defaultConcurrency: 5,
    allowsCustomModelId: false,
    accentClass: "text-emerald-600",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    blurb: "Low-cost default for cost-sensitive bulk runs.",
    apiKeyHint: "Find this at aistudio.google.com → Get API key.",
    defaultConcurrency: 6,
    freeTierWarning:
      "Free tier is useful for testing but has stricter rate limits and may retain content for training. Prefer the paid tier for team usage.",
    allowsCustomModelId: false,
    accentClass: "text-blue-600",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "Ultra-low-cost experimental mode.",
    apiKeyHint: "Find this at platform.deepseek.com → API keys.",
    defaultConcurrency: 5,
    riskNote:
      "Use only for non-confidential demo context. Do not paste sensitive customer, prospect, or internal details unless approved by your team's data-handling policy.",
    allowsCustomModelId: false,
    accentClass: "text-violet-600",
  },
  groq: {
    id: "groq",
    label: "Groq",
    blurb: "Fast preview generation on open-weight models.",
    apiKeyHint: "Find this at console.groq.com → API keys.",
    defaultConcurrency: 8,
    riskNote:
      "Fast preview mode — open-weight models are great for first-pass speed runs. Validate output quality against your validators before using for executive-facing demos.",
    allowsCustomModelId: false,
    accentClass: "text-amber-600",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Advanced custom model router.",
    apiKeyHint: "Find this at openrouter.ai/keys.",
    defaultConcurrency: 4,
    riskNote:
      "Routing can vary by request. Pin a specific provider/model ID for repeatable demos. Avoid random / free fallback routes for production-like demo data.",
    allowsCustomModelId: true,
    accentClass: "text-slate-700",
  },
};

// ---------------------------------------------------------------------------
// MODELS — curated list
// ---------------------------------------------------------------------------
//
// Order matters: when two models for the same provider tie on
// `defaultForPersona` / `defaultForResponse`, the FIRST one in the array
// wins. So put the safest, most-recommended option for each kind first.

export const MODELS: ModelOption[] = [
  // ─── Anthropic ─────────────────────────────────────────────────────────
  // Cost-first defaults (8e): Haiku 4.5 is the recommended default for
  // BOTH persona synthesis and response generation. Sonnet/Opus stay
  // available but neither is the default — they're positioned as
  // premium upgrades for executive demos or unusually nuanced surveys.
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    tagline: "Recommended low-cost default",
    tooltip:
      "Recommended low-cost Anthropic default for both personas and responses. Fast enough for bulk demo generation and good for most SE workflows. Upgrade only when a demo needs more nuance than cost savings.",
    recommendedFor: ["personas", "responses"],
    mode: "balanced",
    qualityTier: "good",
    costTier: "medium",
    speedTier: "very_fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    defaultForPersona: true,
    defaultForResponse: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    tagline: "Premium — executive demos",
    tooltip:
      "Premium quality. Pick when the demo lands in front of executives, the survey is unusually nuanced or multilingual, and quality matters more than cost. Otherwise Haiku 4.5 is the cheaper recommended path.",
    recommendedFor: [],
    mode: "premium",
    qualityTier: "strong",
    costTier: "medium",
    speedTier: "fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
    tagline: "Highest quality · rarely needed",
    tooltip:
      "Premium tier. Almost never the right call for demo data — pick only when responses need exceptional nuance (e.g. a high-stakes regulated-industry pitch). Significantly more expensive than Haiku 4.5.",
    recommendedFor: [],
    mode: "premium",
    qualityTier: "premium",
    costTier: "premium",
    speedTier: "medium",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },

  // ─── OpenAI ────────────────────────────────────────────────────────────
  {
    id: "gpt-4o-mini",
    provider: "openai",
    label: "GPT-4o Mini",
    tagline: "Recommended low-cost persona model",
    tooltip:
      "Recommended low-cost OpenAI persona model. Good for fast profile generation; classic cheap workhorse. Comparable to Haiku — solid fallback if Anthropic is rate-limited.",
    recommendedFor: ["personas"],
    mode: "economy",
    qualityTier: "good",
    costTier: "low",
    speedTier: "very_fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    defaultForPersona: true,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    label: "GPT-4o",
    tagline: "Premium — executive demos",
    tooltip:
      "Premium quality, higher cost. Comparable to Sonnet — pick when responses need extra nuance for an executive demo. Otherwise GPT-4.1 Mini is the cheaper recommended path.",
    recommendedFor: [],
    mode: "premium",
    qualityTier: "strong",
    costTier: "medium",
    speedTier: "fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    label: "GPT-4.1 Mini",
    tagline: "Recommended low-cost response model",
    tooltip:
      "Recommended OpenAI response model. Better response quality while still keeping cost controlled — cheaper than GPT-4o with stronger instruction following. Good default for most SE workflows.",
    recommendedFor: ["responses"],
    mode: "economy",
    qualityTier: "good",
    costTier: "low",
    speedTier: "fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    defaultForResponse: true,
  },
  {
    id: "gpt-4.1-nano",
    provider: "openai",
    label: "GPT-4.1 Nano",
    tagline: "Cheapest OpenAI tier",
    tooltip:
      "Lowest-cost OpenAI tier. Suitable for persona synthesis only — quality is too thin for nuanced responses.",
    recommendedFor: ["personas"],
    mode: "ultra_low_cost",
    qualityTier: "basic",
    costTier: "very_low",
    speedTier: "very_fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    label: "GPT-5 Mini",
    tagline: "Newer mid-tier",
    tooltip:
      "GPT-5 family mid-tier — verify availability and pricing on your OpenAI account before relying on it.",
    recommendedFor: ["responses"],
    mode: "balanced",
    qualityTier: "strong",
    costTier: "low",
    speedTier: "fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    notes: "Availability varies per account; verify on platform.openai.com.",
  },
  {
    id: "gpt-5-nano",
    provider: "openai",
    label: "GPT-5 Nano",
    tagline: "Newer ultra-cheap tier",
    tooltip:
      "GPT-5 nano variant. Cheap and fast. Verify availability and pricing on your OpenAI account before relying on it.",
    recommendedFor: ["personas"],
    mode: "ultra_low_cost",
    qualityTier: "basic",
    costTier: "very_low",
    speedTier: "very_fast",
    riskLevel: "enterprise_safe",
    supportsJson: true,
    notes: "Availability varies per account; verify on platform.openai.com.",
  },

  // ─── Google Gemini ─────────────────────────────────────────────────────
  {
    id: "gemini-2.5-flash-lite",
    provider: "google",
    label: "Gemini 2.5 Flash-Lite",
    tagline: "Best low-cost default for bulk demo data",
    tooltip:
      "Recommended economy default for cost-sensitive SE usage. Reliable JSON output, very low cost, multilingual.",
    recommendedFor: ["personas", "responses"],
    mode: "economy",
    qualityTier: "good",
    costTier: "very_low",
    speedTier: "very_fast",
    riskLevel: "business_safe",
    supportsJson: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    defaultForPersona: true,
    defaultForResponse: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    tagline: "Balanced — better response quality",
    tooltip:
      "Step up from Flash-Lite. Better response nuance, still very fast. Solid balanced default for response generation.",
    recommendedFor: ["responses"],
    mode: "balanced",
    qualityTier: "strong",
    costTier: "low",
    speedTier: "fast",
    riskLevel: "business_safe",
    supportsJson: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    tagline: "Premium Google tier",
    tooltip:
      "Highest-quality Gemini tier. Usually overkill for bulk demo data; reserve for executive demos with complex multilingual context.",
    recommendedFor: [],
    mode: "premium",
    qualityTier: "premium",
    costTier: "high",
    speedTier: "medium",
    riskLevel: "business_safe",
    supportsJson: true,
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
  },

  // ─── DeepSeek ──────────────────────────────────────────────────────────
  {
    id: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek Chat",
    tagline: "Ultra-low-cost chat tier",
    tooltip:
      "Cheap chat-tier model from DeepSeek. Useful for bulk demo data where realism matters more than nuance. AVOID sensitive customer / prospect context.",
    recommendedFor: ["personas", "responses"],
    mode: "ultra_low_cost",
    qualityTier: "good",
    costTier: "very_low",
    speedTier: "fast",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    defaultForPersona: true,
    defaultForResponse: true,
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek Reasoner",
    tagline: "Slower reasoning tier",
    tooltip:
      "Reasoner-class model. Slower; usually overkill for persona/response generation. Same data-handling caveats as deepseek-chat.",
    recommendedFor: [],
    mode: "ultra_low_cost",
    qualityTier: "strong",
    costTier: "low",
    speedTier: "slow",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
  },

  // ─── Groq ──────────────────────────────────────────────────────────────
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B",
    tagline: "Fast open-weight 120B on Groq",
    tooltip:
      "Open-weight GPT-OSS 120B hosted by Groq. Very fast first-pass quality. Validate output before using for executive demos.",
    recommendedFor: ["responses"],
    mode: "fast_preview",
    qualityTier: "good",
    costTier: "low",
    speedTier: "very_fast",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    defaultForResponse: true,
  },
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    tagline: "Cheaper open-weight 20B",
    tooltip:
      "Open-weight GPT-OSS 20B hosted by Groq. Cheaper but slightly less consistent than the 120B variant.",
    recommendedFor: ["personas"],
    mode: "fast_preview",
    qualityTier: "basic",
    costTier: "very_low",
    speedTier: "very_fast",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    defaultForPersona: true,
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B Versatile",
    tagline: "Solid Llama on Groq",
    tooltip:
      "70B Llama 3.3 hosted by Groq. Fast and capable; reliable JSON output. Good for preview runs.",
    recommendedFor: ["responses"],
    mode: "fast_preview",
    qualityTier: "good",
    costTier: "low",
    speedTier: "very_fast",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  },
  {
    id: "llama-3.1-8b-instant",
    provider: "groq",
    label: "Llama 3.1 8B Instant",
    tagline: "Cheap 8B fast preview",
    tooltip:
      "8B Llama 3.1 — extremely cheap, suited to first-pass preview runs only. Quality is thin for nuanced responses.",
    recommendedFor: ["personas"],
    mode: "fast_preview",
    qualityTier: "basic",
    costTier: "very_low",
    speedTier: "very_fast",
    riskLevel: "internal_demo_only",
    supportsJson: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  },

  // ─── OpenRouter ────────────────────────────────────────────────────────
  // OpenRouter is a meta-router. Curated suggestions; users can also enter a
  // custom model ID in the UI (`allowsCustomModelId: true` on the provider).
  {
    id: "openrouter:custom",
    provider: "openrouter",
    label: "Custom model ID",
    tagline: "Pin any OpenRouter model",
    tooltip:
      "Enter a specific OpenRouter model ID (e.g. anthropic/claude-3.7-sonnet). Pricing varies per route. Prefer pinned IDs over random/free routes for repeatability.",
    recommendedFor: ["personas", "responses"],
    mode: "advanced",
    qualityTier: "good",
    costTier: "medium",
    speedTier: "medium",
    riskLevel: "business_safe",
    supportsJson: true,
    defaultForPersona: true,
    defaultForResponse: true,
    notes:
      "Sentinel ID — the actual model ID is supplied separately in the form. The router dispatcher rewrites this before the upstream call.",
  },
  {
    id: "anthropic/claude-3.5-haiku",
    provider: "openrouter",
    label: "Claude 3.5 Haiku (via OpenRouter)",
    tagline: "Suggested OpenRouter pin",
    tooltip:
      "Anthropic Haiku 3.5 via OpenRouter. Pricing varies by route; verify on openrouter.ai/models.",
    recommendedFor: ["personas"],
    mode: "advanced",
    qualityTier: "good",
    costTier: "medium",
    speedTier: "fast",
    riskLevel: "business_safe",
    supportsJson: true,
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "openrouter",
    label: "Gemini 2.5 Flash (via OpenRouter)",
    tagline: "Suggested OpenRouter pin",
    tooltip:
      "Google Gemini 2.5 Flash via OpenRouter. Pricing varies by route; verify on openrouter.ai/models.",
    recommendedFor: ["responses"],
    mode: "advanced",
    qualityTier: "strong",
    costTier: "medium",
    speedTier: "fast",
    riskLevel: "business_safe",
    supportsJson: true,
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getModel(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

export function getModelsByProvider(provider: LLMProvider): ModelOption[] {
  return MODELS.filter((m) => m.provider === provider && !m.deprecated);
}

/** @deprecated Renamed to `getModelsByProvider` — kept for back-compat. */
export const getModelsForProvider = getModelsByProvider;

export function getProviderMeta(provider: LLMProvider): ProviderMeta {
  return PROVIDER_META[provider];
}

export function getProviderLabel(provider: LLMProvider): string {
  return PROVIDER_META[provider].label;
}

export function getProviderKeyHint(provider: LLMProvider): string {
  return PROVIDER_META[provider].apiKeyHint;
}

export function getProviderRiskNote(provider: LLMProvider): string | undefined {
  return PROVIDER_META[provider].riskNote;
}

/**
 * Default concurrency for a provider+kind combo. Used by the synthesizer
 * (`personas`) and response generator (`responses`). Kind is accepted for
 * future per-kind tuning but currently both use the provider-level default.
 */
export function getProviderConcurrency(
  provider: LLMProvider,
  _modelId?: string,
): number {
  return PROVIDER_META[provider].defaultConcurrency;
}

/**
 * Find the recommended default model for a (provider, kind). Falls back to
 * the first non-deprecated model for the provider if nothing's marked as a
 * default — this should never happen with the curated list but keeps things
 * sane during development.
 */
function findDefaultModel(
  provider: LLMProvider,
  kind: "personas" | "responses",
): ModelOption | undefined {
  const flag = kind === "personas" ? "defaultForPersona" : "defaultForResponse";
  const candidates = getModelsByProvider(provider);
  return (
    candidates.find((m) => (m as ModelOption & Record<string, unknown>)[flag] === true) ??
    candidates.find((m) => m.recommendedFor.includes(kind)) ??
    candidates[0]
  );
}

export function getRecommendedPersonaModel(provider: LLMProvider): string {
  return findDefaultModel(provider, "personas")?.id ?? "";
}

export function getRecommendedResponseModel(provider: LLMProvider): string {
  return findDefaultModel(provider, "responses")?.id ?? "";
}

/** Pair of default model IDs for a provider. Useful when switching providers
 *  in the setup store. */
export function getProviderDefaultModels(provider: LLMProvider): {
  personaModel: string;
  responseModel: string;
} {
  return {
    personaModel: getRecommendedPersonaModel(provider),
    responseModel: getRecommendedResponseModel(provider),
  };
}

/** @deprecated Use `getRecommendedPersonaModel` / `getRecommendedResponseModel`. */
export function getDefaultModel(
  provider: LLMProvider,
  kind: "personas" | "responses",
): string {
  return kind === "personas"
    ? getRecommendedPersonaModel(provider)
    : getRecommendedResponseModel(provider);
}

/** True if pricing is known for this model. UI uses this to decide whether
 *  to surface a "Pricing unavailable" badge in the model selector. */
export function modelHasKnownPricing(modelId: string): boolean {
  return hasPricing(modelId);
}

// Re-export the raw pricing type so callers don't have to dig into pricing.ts.
export type { RawModelPricing as ModelPricing };

// ---------------------------------------------------------------------------
// Mode grouping helper for the UI
// ---------------------------------------------------------------------------

export const MODE_ORDER: ModelMode[] = [
  "economy",
  "balanced",
  "premium",
  "ultra_low_cost",
  "fast_preview",
  "advanced",
];

export function groupModelsByMode(
  models: ModelOption[],
): Array<{ mode: ModelMode; label: string; models: ModelOption[] }> {
  const buckets = new Map<ModelMode, ModelOption[]>();
  for (const m of models) {
    const arr = buckets.get(m.mode) ?? [];
    arr.push(m);
    buckets.set(m.mode, arr);
  }
  return MODE_ORDER.filter((mode) => buckets.has(mode)).map((mode) => ({
    mode,
    label: MODE_LABELS[mode],
    models: buckets.get(mode)!,
  }));
}
