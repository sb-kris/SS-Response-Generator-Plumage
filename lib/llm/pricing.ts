// Per-model pricing in USD per 1M tokens.
//
// ⚠️  RECHECK QUARTERLY: provider pricing changes more often than you think.
// When a model gets a price cut or a new mini variant ships, this table is
// where it shows up. The cost estimator and UI both source from here — if
// pricing is missing or out-of-date, the UI will (correctly) say so rather
// than fabricate a number.
//
// Verification sources to consult on next sweep:
//   - Anthropic:  https://docs.claude.com/en/docs/about-claude/models
//   - OpenAI:     https://openai.com/api/pricing/
//   - Google:     https://ai.google.dev/gemini-api/docs/pricing
//   - DeepSeek:   https://api-docs.deepseek.com/quick_start/pricing
//   - Groq:       https://console.groq.com/docs/models
//   - OpenRouter: https://openrouter.ai/models — per-model, varies by route
//
// When you add a model:
//   1) Set `source: "official"` only if you literally copied the number from
//      the provider's pricing page in the last 30 days.
//   2) Otherwise use `"manual"` and put a `notes` field with where you got it.
//   3) If you can't verify, OMIT the entry (or set to null) — the estimator
//      and UI both handle missing pricing gracefully.

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTokUsd: number;
  /** USD per 1M output tokens. */
  outputPerMTokUsd: number;
  /** Cached / prompt-cache hits, if the provider exposes a discount tier.
   *  Phase 4 doesn't use prompt caching yet but the field is here so a
   *  future cache-aware estimator doesn't need a schema change. */
  cachedInputPerMTokUsd?: number;
  /** Where the numbers came from.
   *  - "official": copied from the provider's official pricing page.
   *  - "manual":   from a community source, an announcement post, or a
   *                screenshot — less trustworthy. */
  source: "official" | "manual";
  /** YYYY-MM (or YYYY-MM-DD) of the most recent verification. The UI surfaces
   *  this so users know whether to trust the displayed cost. */
  verifiedAt: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Legacy field-name compatibility
// ---------------------------------------------------------------------------
//
// The old shape was `{ input, output }`. Some callers may still reach for
// `.input` / `.output` until they're migrated. We attach matching getters so
// the move is non-breaking; new code should use the per-MTok fields.

interface LegacyAlias {
  /** @deprecated Use `inputPerMTokUsd` instead. */
  readonly input: number;
  /** @deprecated Use `outputPerMTokUsd` instead. */
  readonly output: number;
}

function withLegacy(p: ModelPricing): ModelPricing & LegacyAlias {
  return Object.assign(Object.create(null), p, {
    get input() {
      return p.inputPerMTokUsd;
    },
    get output() {
      return p.outputPerMTokUsd;
    },
  }) as ModelPricing & LegacyAlias;
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------
//
// Keys are exactly the model IDs sent to the upstream API (so `openai/gpt-oss-120b`
// for Groq, `models/gemini-2.5-flash-lite` is normalized to `gemini-2.5-flash-lite`).
//
// If a model is missing here, `MODEL_PRICING[id]` returns undefined and the
// estimator surfaces "pricing unavailable" instead of guessing.

const RAW_PRICING: Record<string, ModelPricing> = {
  // ─── Anthropic (verified May 2026; same numbers shipped in the prior table) ─
  "claude-haiku-4-5-20251001": {
    inputPerMTokUsd: 1.0,
    outputPerMTokUsd: 5.0,
    source: "official",
    verifiedAt: "2026-05",
  },
  "claude-sonnet-4-6": {
    inputPerMTokUsd: 3.0,
    outputPerMTokUsd: 15.0,
    source: "official",
    verifiedAt: "2026-05",
  },
  "claude-opus-4-7": {
    inputPerMTokUsd: 15.0,
    outputPerMTokUsd: 75.0,
    source: "official",
    verifiedAt: "2026-05",
  },

  // ─── OpenAI ──────────────────────────────────────────────────────────────
  // 4o family — well-known pricing, kept as-is from the prior table.
  "gpt-4o-mini": {
    inputPerMTokUsd: 0.15,
    outputPerMTokUsd: 0.6,
    cachedInputPerMTokUsd: 0.075,
    source: "official",
    verifiedAt: "2026-05",
  },
  "gpt-4o": {
    inputPerMTokUsd: 2.5,
    outputPerMTokUsd: 10.0,
    cachedInputPerMTokUsd: 1.25,
    source: "official",
    verifiedAt: "2026-05",
  },
  // 4.1 family — listed on openai.com/api/pricing.
  "gpt-4.1-mini": {
    inputPerMTokUsd: 0.4,
    outputPerMTokUsd: 1.6,
    cachedInputPerMTokUsd: 0.1,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "Mini tier — comparable cost to GPT-4o Mini, better instruction following.",
  },
  "gpt-4.1-nano": {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.4,
    cachedInputPerMTokUsd: 0.025,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "Nano tier — cheapest OpenAI tier in current lineup.",
  },
  // GPT-5 family — pricing exists for these IDs but rolls out unevenly per
  // account; treat as manual until you verify on your own org's pricing page.
  "gpt-5-mini": {
    inputPerMTokUsd: 0.25,
    outputPerMTokUsd: 2.0,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Manual entry. Verify against your org's OpenAI pricing page before quoting cost.",
  },
  "gpt-5-nano": {
    inputPerMTokUsd: 0.05,
    outputPerMTokUsd: 0.4,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Manual entry. Lowest-tier GPT-5 variant; verify with your account before quoting cost.",
  },

  // ─── Google Gemini ───────────────────────────────────────────────────────
  // Paid-tier pricing. Free tier exists for testing but limits aren't tracked here.
  "gemini-2.5-flash-lite": {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.4,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Cheapest paid Gemini tier. Free tier available for low-volume testing.",
  },
  "gemini-2.5-flash": {
    inputPerMTokUsd: 0.3,
    outputPerMTokUsd: 2.5,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Balanced Gemini tier. Pricing assumes input ≤128K tokens; long-context surcharge applies above.",
  },
  "gemini-2.5-pro": {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10.0,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Premium Gemini tier. Long-context (>200K) surcharge applies; verify before quoting bulk-run cost.",
  },

  // ─── DeepSeek ────────────────────────────────────────────────────────────
  // DeepSeek pricing fluctuates more than the major providers — recheck before
  // demoing.
  "deepseek-chat": {
    inputPerMTokUsd: 0.27,
    outputPerMTokUsd: 1.1,
    cachedInputPerMTokUsd: 0.07,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "DeepSeek-V3-class chat model. Pricing varies; verify on api-docs.deepseek.com.",
  },
  "deepseek-reasoner": {
    inputPerMTokUsd: 0.55,
    outputPerMTokUsd: 2.19,
    cachedInputPerMTokUsd: 0.14,
    source: "manual",
    verifiedAt: "2026-05",
    notes:
      "Reasoner-class model. Slower; usually overkill for persona/response generation.",
  },

  // ─── Groq ────────────────────────────────────────────────────────────────
  // Groq hosts open-weight models at extremely fast throughput. Pricing per
  // Groq's published rates as of May 2026; numbers move when Groq retunes.
  "llama-3.3-70b-versatile": {
    inputPerMTokUsd: 0.59,
    outputPerMTokUsd: 0.79,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "70B Llama 3.3 hosted by Groq; very fast, modest quality for personas.",
  },
  "llama-3.1-8b-instant": {
    inputPerMTokUsd: 0.05,
    outputPerMTokUsd: 0.08,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "8B Llama 3.1 — extremely cheap, suited to first-pass preview runs only.",
  },
  "openai/gpt-oss-120b": {
    inputPerMTokUsd: 0.15,
    outputPerMTokUsd: 0.75,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "Open-weight GPT-OSS 120B hosted by Groq. Verify before final demos.",
  },
  "openai/gpt-oss-20b": {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    source: "manual",
    verifiedAt: "2026-05",
    notes: "Open-weight GPT-OSS 20B hosted by Groq. Cheaper than the 120B variant.",
  },
};

// Expose a frozen map of pricing entries, each with legacy `.input` / `.output`
// accessors so older call-sites keep compiling while we migrate.
export const MODEL_PRICING: Readonly<Record<string, ModelPricing & LegacyAlias>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_PRICING).map(([id, p]) => [id, withLegacy(p)]),
  ),
);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

export function hasPricing(modelId: string): boolean {
  return Boolean(MODEL_PRICING[modelId]);
}

/**
 * Format a "$X.XX per 1M input · $Y.YY per 1M output" string for tooltips.
 * Returns `null` if pricing is unknown so callers can show a fallback.
 */
export function formatPricingShort(modelId: string): string | null {
  const p = MODEL_PRICING[modelId];
  if (!p) return null;
  return `$${p.inputPerMTokUsd.toFixed(2)}/M in · $${p.outputPerMTokUsd.toFixed(2)}/M out`;
}

export function pricingVerifiedAt(modelId: string): string | null {
  return MODEL_PRICING[modelId]?.verifiedAt ?? null;
}
