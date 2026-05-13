// Phase 5a — Response schema.
//
// `GeneratedResponse` is the unit of output for a single persona. It stores
// that persona's complete set of answers to the survey, keyed by SS question
// id. Identity / geography / device / variables / submission timestamp all
// live on the linked `Persona` and are NOT duplicated here — the 5c push
// builder reads both objects to assemble the SS payload.
//
// The `AnswerValue` union is intentionally LLM-friendly: single-select
// choices are scalar IDs, sub-question types (matrix / group_rating /
// constant_sum) are kept grouped as `Record<rowId, …>`. The wire format SS
// requires (`answer: [choiceId]` for even single-select; one answer object
// per matrix row with `parent_question_id`) is produced only at push time
// in `lib/surveysparrow/response-builder.ts` (5c). Keeping this internal
// shape ergonomic matters more for the validator and the preview UI than
// matching the wire 1:1.
//
// SECURITY: this type carries no credentials. The responses-store
// sessionStorage-persists it to survive accidental refreshes within a tab
// but never carries API keys.

import type { Persona } from "./persona-types";

export type ResponseStatus = "generated" | "pushing" | "pushed" | "failed";

// ---------------------------------------------------------------------------
// AnswerValue — discriminated union, one variant per logical question type.
// ---------------------------------------------------------------------------

export type AnswerValue =
  // ---- Free-text / scalar ----
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "url"; value: string }
  | { type: "email"; value: string }
  | { type: "phone"; value: string }
  /** Internal storage is ISO 8601; the 5c builder reformats to the
   *  question's configured `date_format`. */
  | { type: "date"; value: string }

  // ---- Numeric scales ----
  | { type: "nps"; value: number } // 0–10 integer
  | { type: "csat"; value: number } // 1–5 integer
  | { type: "ces"; value: number } // 1–7 integer
  | { type: "rating"; value: number; scale: { min: number; max: number } }
  | { type: "opinion_scale"; value: number; scale: { min: number; max: number } }
  | { type: "slider"; value: number; scale: { min: number; max: number } }

  // ---- Boolean ----
  | { type: "yes_no"; value: boolean } // builder maps to "Yes"/"No"

  // ---- Choice questions ----
  | { type: "single_choice"; choiceId: number; choiceLabel: string }
  | { type: "dropdown"; choiceId: number; choiceLabel: string }
  | {
      type: "multi_choice";
      choices: Array<{ id: number; label: string }>;
    }

  // ---- Matrix variants (subtype determines wire format in 5c) ----
  /** SINGLE_ANSWER: rowId → scalePointId */
  | { type: "matrix_single"; rows: Record<string, number> }
  /** MULTIPLE_ANSWER: rowId → [scalePointIds] */
  | { type: "matrix_multiple"; rows: Record<string, number[]> }
  /** DROP_DOWN: rowId → choiceId (from that column's choice list) */
  | { type: "matrix_dropdown"; rows: Record<string, number> }
  /** TEXT_INPUT: rowId → array of (columnId, text) cells */
  | {
      type: "matrix_text";
      rows: Record<string, Array<{ columnId: number; text: string }>>;
    }
  /** RATING: rowId → array of (columnId, value) cells */
  | {
      type: "matrix_rating";
      rows: Record<string, Array<{ columnId: number; value: number }>>;
    }

  // ---- Per-row sub-questions ----
  /** GroupRating: each statement gets a numeric rating. */
  | {
      type: "group_rating";
      rows: Record<string, number>;
      scale: { min: number; max: number };
    }
  /** ConstantSum: each row gets an integer; sum across rows = totalSum. */
  | { type: "constant_sum"; rows: Record<string, number>; totalSum: number }

  // ---- Ordered ----
  | { type: "ranking"; orderedChoiceIds: number[] };

// Convenience type alias for the discriminator.
export type AnswerType = AnswerValue["type"];

// ---------------------------------------------------------------------------
// GeneratedResponse — one persona's complete set of answers.
// ---------------------------------------------------------------------------

export interface GeneratedResponse {
  /** Plumage-internal uuid (used for keying lists, push retry tracking). */
  id: string;
  /** Links to `Persona.id`. */
  personaId: string;
  /** Denormalized for display so the preview table doesn't have to look up the
   *  persona array on every render. */
  personaName: string;
  /** Keyed by SS question id (stringified). One entry per answerable question
   *  in the survey. Non-answerable questions (welcome screens, file uploads,
   *  etc.) are excluded. ContactForm is also excluded — its sub-fields are
   *  filled from persona contact data by the 5c builder. */
  answers: Record<string, AnswerValue>;
  /** Wall-clock ms at generation completion (NOT submission time — see
   *  `Persona.submittedAt` for that). */
  generatedAt: number;
  /** Status starts as "generated"; flips to "pushing" / "pushed" / "failed"
   *  during the 5c push flow. */
  status: ResponseStatus;
  /** SS-side response id, populated after a successful push (5c). */
  pushedResponseId?: string;
  /** Human-readable error from the SS API if push failed (5c). */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// SSE event union — the orchestrator yields these, the route serializes them,
// the client consumes them.
// ---------------------------------------------------------------------------

export type GenerateResponsesEvent =
  | { type: "start"; total: number }
  | {
      type: "progress";
      completed: number;
      total: number;
      latestPersonaName: string;
    }
  | {
      type: "persona_warning";
      personaId: string;
      personaName: string;
      message: string;
    }
  /** Emitted for EACH persona's response as soon as it lands. The client
   *  appends this to the responses store immediately so partial work is
   *  preserved even if the run later fails or the tab closes. The final
   *  `complete` event still carries the full array as authoritative
   *  reconciliation in case any incremental event was lost. */
  | { type: "response_completed"; response: GeneratedResponse }
  | { type: "complete"; responses: GeneratedResponse[] }
  | { type: "error"; message: string }
  /** Observability events — never affect correctness. The client appends
   *  these to the debug log for the live panel and post-mortem inspection. */
  | {
      type: "debug";
      kind: "worker_start" | "worker_done" | "worker_fail" | "rate_limit" | "retry";
      /** Short human-readable label (persona names, retry reason, …). */
      label: string;
      /** Wall-clock ms from group dispatch to settlement. kind=worker_done only. */
      latencyMs?: number;
      /** Rate-limit sleep duration in ms. kind=rate_limit only. */
      backoffMs?: number;
    };

// ---------------------------------------------------------------------------
// Aggregate stats — used by the basic preview (5a) and stats bar (5b).
// ---------------------------------------------------------------------------

export interface ResponseSummary {
  total: number;
  bySentiment: { promoter: number; passive: number; detractor: number };
  byLanguage: Record<string, number>;
  /** null if no NPS questions were present. */
  averageNps: number | null;
  /** null if no CSAT questions were present. */
  averageCsat: number | null;
  /** Top open-text concerns by simple word frequency — best-effort. */
  topThemes: Array<{ theme: string; count: number }>;
}

/**
 * Compute aggregate stats for a set of responses. The persona array is needed
 * to look up sentiment + language; we accept either the full Persona objects
 * or a thin index keyed by id.
 */
export function summarizeResponses(
  responses: GeneratedResponse[],
  personas: Persona[],
): ResponseSummary {
  const byPersonaId = new Map(personas.map((p) => [p.id, p] as const));

  const bySentiment = { promoter: 0, passive: 0, detractor: 0 };
  const byLanguage: Record<string, number> = {};

  let npsSum = 0;
  let npsCount = 0;
  let csatSum = 0;
  let csatCount = 0;

  const wordCounts = new Map<string, number>();

  for (const r of responses) {
    const persona = byPersonaId.get(r.personaId);
    if (persona) {
      bySentiment[persona.sentimentArchetype] += 1;
      byLanguage[persona.language] = (byLanguage[persona.language] ?? 0) + 1;
    }

    for (const answer of Object.values(r.answers)) {
      if (answer.type === "nps") {
        npsSum += answer.value;
        npsCount += 1;
      } else if (answer.type === "csat") {
        csatSum += answer.value;
        csatCount += 1;
      } else if (answer.type === "text") {
        // Cheap word-frequency on open-text — useful for the "top themes"
        // chips. Uses a tiny stop-list and a length filter. Not Unicode-aware
        // beyond /\p{L}/ — good enough for English; non-English open-text
        // contributes mostly noise here, which is acceptable.
        for (const word of tokenize(answer.value)) {
          wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
        }
      }
    }
  }

  const topThemes = [...wordCounts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  return {
    total: responses.length,
    bySentiment,
    byLanguage,
    averageNps: npsCount > 0 ? npsSum / npsCount : null,
    averageCsat: csatCount > 0 ? csatSum / csatCount : null,
    topThemes,
  };
}

// English-skewed stop list — keeps the top-themes chips from being dominated
// by "the / and / was". Non-English personas mostly drop out via the length
// filter; expanding this is a 5b polish concern.
const STOP_WORDS = new Set([
  "the", "and", "was", "for", "with", "that", "this", "have", "had", "but",
  "are", "you", "your", "our", "from", "they", "their", "would", "could",
  "should", "been", "very", "just", "really", "quite", "more", "most", "some",
  "than", "what", "when", "where", "which", "while", "who", "why", "how",
  "any", "all", "out", "off", "not", "also", "into", "over", "after", "before",
  "about", "because", "though", "even", "still", "much", "many", "few",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}
