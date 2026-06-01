// Phase 8 — AI Setup Assistant types + deterministic helpers.
//
// Two layers here:
//   1. Wire types — what the LLM is asked to produce, what the API
//      routes accept/return, what the dialog binds to.
//   2. Deterministic helpers — sentiment-shape → distribution,
//      survey-type → timing window. These DO NOT call the LLM. The LLM
//      handles the creative work (context paragraph, themes, custom
//      variables) and we wrap deterministic distributions around it.
//
// SECURITY: this module carries no secrets. Credentials flow only through
// the route handlers and are never persisted.

import type {
  CustomVariable,
  PersonaDistribution,
  StringValueOption,
  ThemeConfig,
  TimePattern,
  TimeRangeConfig,
} from "@/lib/profiles/types";

// ---------------------------------------------------------------------------
// Sentiment shape — drives persona distribution deterministically.
// ---------------------------------------------------------------------------

export type SentimentShape = "mostly_positive" | "balanced" | "recovery" | "polarized";

export interface SentimentShapeEntry {
  id: SentimentShape;
  label: string;
  description: string;
  distribution: PersonaDistribution;
}

/**
 * Canonical sentiment-shape presets. The LLM does NOT produce these; we
 * map directly from the user's selection. Predictable, cheap, and matches
 * the existing PersonasSection's sum-to-100 contract by construction.
 */
export const SENTIMENT_SHAPES: ReadonlyArray<SentimentShapeEntry> = [
  {
    id: "mostly_positive",
    label: "Mostly positive",
    description: "Promoter-heavy. Best for happy-path demos and renewals.",
    distribution: { promoter: 70, passive: 20, detractor: 10 },
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Realistic mix across promoter / passive / detractor.",
    distribution: { promoter: 55, passive: 25, detractor: 20 },
  },
  {
    id: "recovery",
    label: "Recovery (detractor-heavy)",
    description: "More detractors. Use for support, churn, or CSAT recovery demos.",
    distribution: { promoter: 25, passive: 30, detractor: 45 },
  },
  {
    id: "polarized",
    label: "Polarized",
    description: "Strong promoter and detractor groups with few passives.",
    distribution: { promoter: 45, passive: 10, detractor: 45 },
  },
] as const;

export function distributionForShape(shape: SentimentShape): PersonaDistribution {
  const entry = SENTIMENT_SHAPES.find((s) => s.id === shape);
  return entry ? { ...entry.distribution } : { promoter: 55, passive: 25, detractor: 20 };
}

// ---------------------------------------------------------------------------
// Timing window — deterministic from survey type, not LLM.
// ---------------------------------------------------------------------------

/**
 * Recent date-range window for response date_time, keyed off the survey type
 * canonical (NPS / CSAT / CES / classicform / kiosk / ...). The values match
 * typical real-world cadences SEs see in customer demos:
 *
 *   - NPS / quarterly tracking      → last 90 days
 *   - CSAT / transactional support  → last 30 days (more recent = more relevant)
 *   - CES / post-resolution         → last 30 days
 *   - Post-purchase / product       → last 60 days
 *   - Generic ClassicForm           → last 45 days
 *
 * We always return a "realistic_mix" pattern with business-hours weighting on,
 * matching the default the TimingSection ships with for new drafts.
 */
export function timingForSurveyType(
  surveyTypeRaw: string,
  responseCount: number,
): TimeRangeConfig {
  const t = surveyTypeRaw.toLowerCase();
  const days = (() => {
    if (t.includes("nps")) return 90;
    if (t.includes("csat")) return 30;
    if (t.includes("ces")) return 30;
    if (t.includes("kiosk") || t.includes("post")) return 60;
    return 45; // ClassicForm / Conversational / unknown
  })();
  const now = Date.now();
  return {
    from: now - days * 24 * 60 * 60 * 1000,
    to: now,
    pattern: "realistic_mix" satisfies TimePattern,
    businessHoursWeight: true,
    responseCount,
  };
}

// ---------------------------------------------------------------------------
// LLM I/O — the JSON the model is asked to produce.
//
// We keep the LLM responsibility narrow: context paragraph, theme list,
// custom variable suggestions (STRING-typed only for first cut). Persona
// distribution and timing are computed deterministically above.
// ---------------------------------------------------------------------------

export interface SetupAssistantLLMOutput {
  context: string;
  themes: Array<{ label: string; weight: number; reason?: string }>;
  /**
   * Variable suggestions from the LLM. Each entry can be STRING, NUMBER,
   * or DATE-typed; the validator dispatches by `type` and builds the
   * matching CustomVariableValues shape downstream. STRING is the
   * historical default — pre-existing LLM outputs that omit type or
   * the `numberConfig` / `dateConfig` blocks continue to validate as
   * STRING with options[].
   */
  customVariables: Array<{
    label: string;
    apiIdentifier: string;
    /** Defaults to "STRING" when omitted (backward compat). */
    type?: "STRING" | "NUMBER" | "DATE";
    /**
     * Where the variable originated. Optional in the LLM output: when
     * omitted we infer it by matching `apiIdentifier` against the SS
     * variables the dialog passed in. The LLM SHOULD set this to
     * `surveysparrow_variable` when enriching an existing workspace
     * variable so the dialog can show the right badge ("SS") and skip
     * sending it to the variable-creation endpoint at push time.
     */
    source?: "ai_suggested" | "surveysparrow_variable";
    /** STRING-only — weighted options the persona picks from per response. */
    options?: Array<{ text: string; weight: number }>;
    /** NUMBER-only — describes a range or a static value. */
    numberConfig?: {
      mode?: "range" | "static";
      min?: number;
      max?: number;
      staticValue?: number;
      allowDecimals?: boolean;
      decimalPlaces?: number;
    };
    /** DATE-only — describes a relative window or an absolute range.
     *  Dates in the response payload are ALWAYS emitted as YYYY-MM-DD
     *  regardless of how the LLM chose to express them here. */
    dateConfig?: {
      mode?: "relative" | "range";
      relativeDays?: number;
      /** YYYY-MM-DD or epoch ms — validator coerces. */
      start?: string | number;
      end?: string | number;
    };
    reason?: string;
  }>;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Dialog form inputs (Step 1 of the assistant flow).
// ---------------------------------------------------------------------------

export interface SetupAssistantInputs {
  companyName: string;
  companyWebsite?: string;
  sentimentShape: SentimentShape;
  notes?: string;
}

// ---------------------------------------------------------------------------
// SurveySparrow workspace-level variable shape (from /v3/variables).
// Mirror of what the SS API returns — name / label / type / description.
// ---------------------------------------------------------------------------

export interface SurveySparrowVariableSummary {
  /** SS internal id, kept as number to match the API. */
  id: number;
  /** Snake-case identifier (e.g. "customer_email"). This is what we mount
   *  into `CustomVariable.apiIdentifier` when the user applies it. */
  name: string;
  /** Human-readable label (e.g. "Customer Email"). */
  label?: string;
  /** STRING / NUMBER / DATE / SECURE (we treat unknown as STRING).
   *  PERSONA-bound variables surface as type "PERSONA" — SS auto-populates
   *  these from the contact info on each response, so we MUST NOT send
   *  values for them in the push payload (SS rejects the entire response
   *  with "Invalid value passed or missing values in payload"). */
  type?: string;
  description?: string;
  /** Human-readable persona binding (e.g. "persona.firstName") when the
   *  variable is wired to a persona field. Set whenever the route detects
   *  the variable is persona-bound — even when `type` itself doesn't say
   *  PERSONA. Used to (a) skip enrichment in the AI Setup Assistant and
   *  (b) filter the variable out of the response push payload. */
  personaBinding?: string;
}

// ---------------------------------------------------------------------------
// What the dialog renders + applies — a fully-assembled suggestion.
// ---------------------------------------------------------------------------

export interface VariableSuggestion {
  /** Concrete CustomVariable ready to push into the draft. */
  variable: CustomVariable;
  /** Where did this suggestion come from? Drives the UI badge. */
  source: "ai_suggested" | "surveysparrow_variable";
  /** Human explanation from the LLM ("recurring lifecycle field for this survey"). */
  reason?: string;
  /** True if the user's current draft already has this apiIdentifier — UI
   *  shows "already added" instead of an Add button. */
  alreadyAdded: boolean;
}

export interface SetupAssistantSuggestion {
  context: string;
  themes: ThemeConfig[];
  personaDistribution: PersonaDistribution;
  variables: VariableSuggestion[];
  timing: TimeRangeConfig;
  /** Any warnings surfaced by the validator or the LLM itself (e.g.
   *  duplicated apiIdentifier had to be renamed). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Route I/O — server-side request shapes.
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/llm/setup-assistant.
 * Note: SurveySparrow variables are fetched separately by the client and
 * passed in here, so this route doesn't need SS credentials.
 */
export interface SetupAssistantRequest {
  inputs: SetupAssistantInputs;
  survey: {
    name: string;
    type: string;
    /** Up to 30 questions — we trim if the survey is longer to keep the
     *  prompt under the token budget. */
    questions: Array<{
      position: string;
      text: string;
      type: string;
      required?: boolean;
      choices?: Array<{ id?: number; text: string }>;
    }>;
  };
  /** Existing useCase + custom-variable identifiers in the draft, so the
   *  LLM can avoid generic restating and duplicate identifiers. */
  existing?: {
    useCase?: string;
    customVariableIdentifiers?: string[];
  };
  /** SS workspace variables we already fetched, passed so the LLM can
   *  steer around their identifiers. */
  surveySparrowVariables?: SurveySparrowVariableSummary[];
  llm: {
    provider: string;
    apiKey: string;
    model: string;
    customModelId?: string;
  };
}

/** Response body — wraps the raw LLM JSON for the client to assemble. */
export interface SetupAssistantResponse {
  ok: boolean;
  status?: number;
  error?: string;
  output?: SetupAssistantLLMOutput;
}

// ---------------------------------------------------------------------------
// API identifier validation — mirrors the rule used by the existing
// CustomVariablesSection form. Used in the validator to normalise LLM
// output before it reaches the draft.
// ---------------------------------------------------------------------------

const API_ID_REGEX = /^[a-z][a-z0-9_]{0,34}$/;

export function isValidApiIdentifier(id: string): boolean {
  return API_ID_REGEX.test(id);
}

/**
 * Coerce an LLM-supplied identifier to the accepted shape: lowercase,
 * underscores for non-alphanumerics, capped at 35 chars, must start
 * with a letter. Returns null if the result is empty.
 */
export function normaliseApiIdentifier(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 35);
  if (!cleaned) return null;
  // Must start with a letter; if it starts with a digit, prepend `v_`.
  if (!/^[a-z]/.test(cleaned)) return ("v_" + cleaned).slice(0, 35);
  return cleaned;
}

/** Re-export some upstream types so dialog components don't need
 *  to import from two places. */
export type { StringValueOption };
