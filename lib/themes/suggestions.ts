// Survey-type-aware theme suggestions surfaced as clickable chips.
// Match SS's `survey_type` field (e.g. "NPS", "CSAT", "CES", "ClassicForm")
// case-insensitively. Anything we don't recognize falls back to `default`.

export const THEME_SUGGESTIONS_BY_SURVEY_TYPE = {
  nps: [
    "product reliability",
    "support quality",
    "value for money",
    "ease of use",
    "feature gaps",
    "onboarding experience",
    "integration with existing tools",
    "performance and speed",
  ],
  csat: [
    "resolution speed",
    "agent helpfulness",
    "ease of process",
    "communication clarity",
    "knowledge depth",
    "follow-up timeliness",
    "self-service options",
    "first-call resolution",
  ],
  ces: [
    "effort required",
    "process clarity",
    "self-service options",
    "navigation difficulty",
    "documentation quality",
    "form length",
    "automation gaps",
    "support handoffs",
  ],
  default: [
    "product quality",
    "support experience",
    "ease of use",
    "pricing concerns",
    "feature requests",
    "performance issues",
    "missing functionality",
    "integration gaps",
  ],
} as const;

export type SuggestionBucket = keyof typeof THEME_SUGGESTIONS_BY_SURVEY_TYPE;

export const SUGGESTION_LABELS: Record<SuggestionBucket, string> = {
  nps: "NPS",
  csat: "CSAT",
  ces: "CES",
  default: "general",
};

export interface SurveyTypeSuggestions {
  bucket: SuggestionBucket;
  label: string;
  themes: readonly string[];
}

export function getSuggestionsForSurveyType(
  surveyType: string | undefined,
): SurveyTypeSuggestions {
  const lower = (surveyType ?? "").toLowerCase();
  // Order matters: check the more specific labels before the generic ones.
  if (lower.includes("nps")) {
    return {
      bucket: "nps",
      label: SUGGESTION_LABELS.nps,
      themes: THEME_SUGGESTIONS_BY_SURVEY_TYPE.nps,
    };
  }
  if (lower.includes("csat")) {
    return {
      bucket: "csat",
      label: SUGGESTION_LABELS.csat,
      themes: THEME_SUGGESTIONS_BY_SURVEY_TYPE.csat,
    };
  }
  if (lower.includes("ces")) {
    return {
      bucket: "ces",
      label: SUGGESTION_LABELS.ces,
      themes: THEME_SUGGESTIONS_BY_SURVEY_TYPE.ces,
    };
  }
  return {
    bucket: "default",
    label: SUGGESTION_LABELS.default,
    themes: THEME_SUGGESTIONS_BY_SURVEY_TYPE.default,
  };
}
