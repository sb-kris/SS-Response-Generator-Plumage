// Phase 5a — Response validator.
//
// Hand-rolled, mirroring the persona-validator pattern. Takes the parsed
// LLM JSON + the questions it was asked about + the persona it was asked
// to embody, and produces either:
//
//   - A fully typed `Record<questionId, AnswerValue>` ready to store, OR
//   - A list of field-level errors that the orchestrator feeds back into
//     a retry prompt.
//
// Rules philosophy (lifted from the persona-validator):
//   - Be permissive on shape but strict on semantics. If the LLM returns
//     a number where we expected a number-in-an-array, accept it (with a
//     warning) but verify the value falls in the allowed range.
//   - Always denormalize choice labels from the question definition —
//     don't trust the LLM's interpretation of which integer maps to which
//     label.
//   - Sentiment alignment is enforced at validation time. Pre-assigned
//     archetype is authoritative; a Detractor returning NPS 9 fails
//     validation and triggers retry.
//   - "Required minimums match the configuration, not the schema" — a
//     question marked `required: false` that's missing from the LLM
//     output is a warning, not an error.

import type {
  AnswerValue,
  AnswerType,
} from "@/lib/generation/response-types";
import type { Persona, SentimentArchetype } from "@/lib/generation/persona-types";
import type { Question } from "@/lib/surveysparrow/types";
import {
  extractQuestionColumns,
  extractQuestionDisplay,
  extractQuestionRows,
  resolveScale,
} from "@/lib/surveysparrow/types";
import { inferAnswerType } from "@/lib/llm/prompts/response-prompt";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResponseValidationError {
  questionId: string;
  field: string;
  message: string;
}

export interface ResponseValidationResult {
  ok: boolean;
  /** Always populated — best-effort answers for any partial success. */
  answers: Record<string, AnswerValue>;
  errors: ResponseValidationError[];
  /** Non-fatal corrections (e.g. choice ID rounded, label denormalized). */
  warnings: string[];
}

export interface ValidateResponseInput {
  /** The parsed JSON from the LLM. Expected shape: `{ answers: { id: value } }`. */
  parsed: unknown;
  persona: Persona;
  questions: Question[];
  /** Restricts validation to these question IDs (the answerable subset the
   *  prompt covered). If a required question is missing, it's an error. */
  expectedQuestionIds: string[];
  /** Mirror of `BuildResponsePromptResult.expectedAnswerTypes` — drives
   *  the per-question dispatch. */
  expectedAnswerTypes: Record<string, AnswerType>;
}

// ---------------------------------------------------------------------------
// Sentiment alignment ranges (the prompt + validator agree on these)
// ---------------------------------------------------------------------------

const SENTIMENT_RANGES: Record<
  SentimentArchetype,
  {
    nps: { min: number; max: number };
    csat: { min: number; max: number };
    ces: { min: number; max: number };
    /** Fraction of scale, 0..1. Multiplied by (max-min) and added to min. */
    rating: { min: number; max: number };
  }
> = {
  promoter: {
    nps: { min: 9, max: 10 },
    csat: { min: 4, max: 5 },
    ces: { min: 5, max: 7 },
    rating: { min: 0.7, max: 1.0 },
  },
  passive: {
    nps: { min: 7, max: 8 },
    csat: { min: 3, max: 3 },
    ces: { min: 3, max: 5 },
    rating: { min: 0.4, max: 0.7 },
  },
  detractor: {
    nps: { min: 0, max: 6 },
    csat: { min: 1, max: 2 },
    ces: { min: 1, max: 3 },
    rating: { min: 0.0, max: 0.4 },
  },
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function validateResponseOutput(
  input: ValidateResponseInput,
): ResponseValidationResult {
  const errors: ResponseValidationError[] = [];
  const warnings: string[] = [];
  const answers: Record<string, AnswerValue> = {};

  if (!input.parsed || typeof input.parsed !== "object") {
    return {
      ok: false,
      answers,
      errors: [{ questionId: "*", field: "root", message: "Output is not an object." }],
      warnings,
    };
  }

  // Accept either { answers: {...} } or a bare object keyed by question id.
  const root = input.parsed as Record<string, unknown>;
  let raw: Record<string, unknown>;
  if (root.answers && typeof root.answers === "object" && !Array.isArray(root.answers)) {
    raw = root.answers as Record<string, unknown>;
  } else {
    raw = root;
    warnings.push("LLM returned bare answer map (no `answers` envelope); accepted.");
  }

  // Build a question lookup by id (string).
  const questionsById = new Map<string, Question>();
  for (const q of input.questions) questionsById.set(String(q.id), q);

  for (const qid of input.expectedQuestionIds) {
    const expectedType = input.expectedAnswerTypes[qid];
    if (!expectedType) continue;
    const question = questionsById.get(qid);
    if (!question) continue;

    const value = raw[qid];
    if (value === undefined || value === null) {
      const display = extractQuestionDisplay(question);
      if (display.required) {
        errors.push({
          questionId: qid,
          field: "answer",
          message: `Required question is missing from output.`,
        });
      } else {
        warnings.push(`Question ${qid} (optional) was not answered.`);
      }
      continue;
    }

    const r = validateOne({
      questionId: qid,
      expectedType,
      value,
      question,
      persona: input.persona,
    });
    if (r.error) {
      errors.push({ questionId: qid, field: r.error.field, message: r.error.message });
      // Even on error, store the best-effort value if we have one — gives
      // the orchestrator a fallback if retries also fail.
      if (r.answer) answers[qid] = r.answer;
    } else if (r.answer) {
      answers[qid] = r.answer;
      if (r.warning) warnings.push(r.warning);
    }
  }

  return {
    ok: errors.length === 0,
    answers,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Per-question dispatch
// ---------------------------------------------------------------------------

interface ValidateOneInput {
  questionId: string;
  expectedType: AnswerType;
  value: unknown;
  question: Question;
  persona: Persona;
}

interface ValidateOneResult {
  /** Set on success or partial success. */
  answer?: AnswerValue;
  /** Fatal — drives retry. */
  error?: { field: string; message: string };
  /** Non-fatal — surfaced to the user but doesn't block. */
  warning?: string;
}

function validateOne(input: ValidateOneInput): ValidateOneResult {
  const { expectedType, value, question, persona } = input;
  const display = extractQuestionDisplay(question);

  switch (expectedType) {
    case "text":
      return validateText(value);
    case "number":
      return validateNumber(value);
    case "url":
      return validateUrl(value);
    case "email":
      return validateEmail(value);
    case "phone":
      return validatePhone(value);
    case "date":
      return validateDate(value);

    case "nps":
      return validateNps(value, persona.sentimentArchetype);
    case "csat":
      return validateCsat(value, persona.sentimentArchetype);
    case "ces":
      return validateCes(value, persona.sentimentArchetype);

    case "rating":
      return validateRatingLike(value, resolveScale(question, 1, 5), persona.sentimentArchetype, "rating");
    case "opinion_scale":
      return validateRatingLike(value, resolveScale(question, 0, 10), persona.sentimentArchetype, "opinion_scale");
    case "slider":
      return validateRatingLike(value, resolveScale(question, 0, 100), persona.sentimentArchetype, "slider");

    case "yes_no":
      return validateYesNo(value);

    case "single_choice":
    case "dropdown":
      return validateSingleChoice(value, display, expectedType);
    case "multi_choice":
      return validateMultiChoice(value, display);

    case "ranking":
      return validateRanking(value, display);

    case "matrix_single":
      return validateMatrixIdMap(value, question, "matrix_single");
    case "matrix_multiple":
      return validateMatrixIdArrayMap(value, question);
    case "matrix_dropdown":
      return validateMatrixIdMap(value, question, "matrix_dropdown");
    case "matrix_text":
      return validateMatrixCellsText(value, question);
    case "matrix_rating":
      return validateMatrixCellsRating(value, question, resolveScale(question, 1, 5));

    case "group_rating":
      return validateGroupRating(value, question, resolveScale(question, 1, 5), persona.sentimentArchetype);
    case "constant_sum":
      return validateConstantSum(value, question);

    default:
      return { error: { field: "type", message: `Unhandled answer type: ${expectedType as string}` } };
  }
}

// ---------------------------------------------------------------------------
// Per-type validators
// ---------------------------------------------------------------------------

function validateText(value: unknown): ValidateOneResult {
  if (typeof value !== "string") {
    return { error: { field: "value", message: `Expected string, got ${typeof value}.` } };
  }
  const trimmed = value.trim();
  if (trimmed.length < 3) {
    return { error: { field: "value", message: `Open-text answer is too short (${trimmed.length} chars).` } };
  }
  if (trimmed.length > 4000) {
    return {
      answer: { type: "text", value: trimmed.slice(0, 4000) },
      warning: "Open-text answer was truncated to 4000 chars.",
    };
  }
  return { answer: { type: "text", value: trimmed } };
}

function validateNumber(value: unknown): ValidateOneResult {
  const n = coerceNumber(value);
  if (n === null) return { error: { field: "value", message: `Expected number, got ${typeof value}.` } };
  return { answer: { type: "number", value: n } };
}

function validateUrl(value: unknown): ValidateOneResult {
  if (typeof value !== "string") return { error: { field: "value", message: `Expected URL string.` } };
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) {
    return { answer: { type: "url", value: `https://${v}` }, warning: "URL was missing a scheme; prepended https://" };
  }
  return { answer: { type: "url", value: v } };
}

function validateEmail(value: unknown): ValidateOneResult {
  if (typeof value !== "string" || !value.includes("@")) {
    return { error: { field: "value", message: `Expected an email string.` } };
  }
  return { answer: { type: "email", value: value.trim() } };
}

function validatePhone(value: unknown): ValidateOneResult {
  if (typeof value !== "string" || value.trim().length < 4) {
    return { error: { field: "value", message: `Expected a phone string.` } };
  }
  return { answer: { type: "phone", value: value.trim() } };
}

function validateDate(value: unknown): ValidateOneResult {
  if (typeof value !== "string") return { error: { field: "value", message: `Expected ISO date string.` } };
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    return { error: { field: "value", message: `Could not parse date: ${value}` } };
  }
  // Normalize to ISO 8601 — the 5c builder reformats per question's date_format.
  return { answer: { type: "date", value: new Date(t).toISOString() } };
}

function validateYesNo(value: unknown): ValidateOneResult {
  if (typeof value === "boolean") return { answer: { type: "yes_no", value } };
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["yes", "y", "true"].includes(v)) {
      return { answer: { type: "yes_no", value: true }, warning: "Yes/No was returned as a string; coerced to boolean." };
    }
    if (["no", "n", "false"].includes(v)) {
      return { answer: { type: "yes_no", value: false }, warning: "Yes/No was returned as a string; coerced to boolean." };
    }
  }
  return { error: { field: "value", message: `Expected boolean, got ${typeof value}.` } };
}

// --- Numeric scales with sentiment alignment -------------------------------

function validateNps(value: unknown, archetype: SentimentArchetype): ValidateOneResult {
  const n = coerceInteger(value);
  if (n === null) return { error: { field: "value", message: `Expected integer 0–10.` } };
  if (n < 0 || n > 10) return { error: { field: "value", message: `NPS out of range: ${n}.` } };
  const range = SENTIMENT_RANGES[archetype].nps;
  if (n < range.min || n > range.max) {
    return {
      error: {
        field: "value",
        message: `NPS ${n} doesn't match ${archetype} archetype (expected ${range.min}–${range.max}).`,
      },
      answer: { type: "nps", value: clamp(n, range.min, range.max) },
    };
  }
  return { answer: { type: "nps", value: n } };
}

function validateCsat(value: unknown, archetype: SentimentArchetype): ValidateOneResult {
  const n = coerceInteger(value);
  if (n === null) return { error: { field: "value", message: `Expected integer 1–5.` } };
  if (n < 1 || n > 5) return { error: { field: "value", message: `CSAT out of range: ${n}.` } };
  const range = SENTIMENT_RANGES[archetype].csat;
  if (n < range.min || n > range.max) {
    return {
      error: {
        field: "value",
        message: `CSAT ${n} doesn't match ${archetype} archetype (expected ${range.min}–${range.max}).`,
      },
      answer: { type: "csat", value: clamp(n, range.min, range.max) },
    };
  }
  return { answer: { type: "csat", value: n } };
}

function validateCes(value: unknown, archetype: SentimentArchetype): ValidateOneResult {
  const n = coerceInteger(value);
  if (n === null) return { error: { field: "value", message: `Expected integer 1–7.` } };
  if (n < 1 || n > 7) return { error: { field: "value", message: `CES out of range: ${n}.` } };
  const range = SENTIMENT_RANGES[archetype].ces;
  if (n < range.min || n > range.max) {
    return {
      error: {
        field: "value",
        message: `CES ${n} doesn't match ${archetype} archetype (expected ${range.min}–${range.max}).`,
      },
      answer: { type: "ces", value: clamp(n, range.min, range.max) },
    };
  }
  return { answer: { type: "ces", value: n } };
}

function validateRatingLike(
  value: unknown,
  scale: { min: number; max: number },
  archetype: SentimentArchetype,
  type: "rating" | "opinion_scale" | "slider",
): ValidateOneResult {
  const n = coerceNumber(value);
  if (n === null) {
    return { error: { field: "value", message: `Expected number ${scale.min}–${scale.max}.` } };
  }
  if (n < scale.min || n > scale.max) {
    return { error: { field: "value", message: `Value ${n} outside scale ${scale.min}–${scale.max}.` } };
  }
  // Sentiment alignment as a fraction of the scale.
  const range = SENTIMENT_RANGES[archetype].rating;
  const span = scale.max - scale.min;
  const minAllowed = scale.min + range.min * span;
  const maxAllowed = scale.min + range.max * span;
  // Allow ±1 tolerance to give the LLM room — strict alignment is overkill
  // for free-form scales (3–10 etc.) where exact bucketing is silly.
  const tolerance = Math.max(1, span * 0.05);
  if (n < minAllowed - tolerance || n > maxAllowed + tolerance) {
    return {
      error: {
        field: "value",
        message: `${type} value ${n} doesn't match ${archetype} archetype (expected ~${minAllowed.toFixed(0)}–${maxAllowed.toFixed(0)} on ${scale.min}–${scale.max} scale).`,
      },
      answer: buildRatingAnswer(type, clamp(n, minAllowed, maxAllowed), scale),
    };
  }
  // Round to integer for rating/opinion_scale (slider can be float).
  const finalValue = type === "slider" ? n : Math.round(n);
  return { answer: buildRatingAnswer(type, finalValue, scale) };
}

function buildRatingAnswer(
  type: "rating" | "opinion_scale" | "slider",
  value: number,
  scale: { min: number; max: number },
): AnswerValue {
  if (type === "rating") return { type: "rating", value, scale };
  if (type === "opinion_scale") return { type: "opinion_scale", value, scale };
  return { type: "slider", value, scale };
}

// --- Choice validators -----------------------------------------------------

function validateSingleChoice(
  value: unknown,
  display: ReturnType<typeof extractQuestionDisplay>,
  type: "single_choice" | "dropdown",
): ValidateOneResult {
  const choices = display.choices ?? [];
  if (choices.length === 0) {
    return { error: { field: "choices", message: "Question has no choices." } };
  }
  let id: number | null = null;

  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return {
        error: {
          field: "value",
          message: `${type} expects an array of exactly one ID; got length ${value.length}.`,
        },
      };
    }
    id = coerceInteger(value[0]);
  } else {
    // Permissive: accept a scalar ID and warn.
    id = coerceInteger(value);
  }
  if (id === null) {
    return { error: { field: "value", message: `Could not coerce choice ID from: ${JSON.stringify(value)}` } };
  }
  const found = choices.find((c) => c.id === id);
  if (!found || found.id == null) {
    return {
      error: {
        field: "value",
        message: `Choice ID ${id} not in this question's options. Valid IDs: ${choices.map((c) => c.id).join(", ")}.`,
      },
    };
  }
  return {
    answer:
      type === "single_choice"
        ? { type: "single_choice", choiceId: found.id, choiceLabel: found.text }
        : { type: "dropdown", choiceId: found.id, choiceLabel: found.text },
    warning: !Array.isArray(value) ? `${type} returned scalar; coerced to array.` : undefined,
  };
}

function validateMultiChoice(
  value: unknown,
  display: ReturnType<typeof extractQuestionDisplay>,
): ValidateOneResult {
  const choices = display.choices ?? [];
  if (choices.length === 0) {
    return { error: { field: "choices", message: "Question has no choices." } };
  }
  if (!Array.isArray(value)) {
    return { error: { field: "value", message: `Expected array of choice IDs.` } };
  }
  if (value.length === 0) {
    return { error: { field: "value", message: `Multi-choice answer must include at least 1 option.` } };
  }
  const out: Array<{ id: number; label: string }> = [];
  for (const v of value) {
    const id = coerceInteger(v);
    if (id === null) {
      return { error: { field: "value", message: `Could not coerce ID from: ${JSON.stringify(v)}` } };
    }
    const found = choices.find((c) => c.id === id);
    if (!found || found.id == null) {
      return {
        error: {
          field: "value",
          message: `Choice ID ${id} not in this question's options.`,
        },
      };
    }
    if (out.some((x) => x.id === found.id)) continue; // dedupe silently
    out.push({ id: found.id, label: found.text });
  }
  return { answer: { type: "multi_choice", choices: out } };
}

function validateRanking(
  value: unknown,
  display: ReturnType<typeof extractQuestionDisplay>,
): ValidateOneResult {
  const choices = display.choices ?? [];
  if (choices.length === 0) {
    return { error: { field: "choices", message: "Question has no choices." } };
  }
  if (!Array.isArray(value)) {
    return { error: { field: "value", message: `Expected ordered array of all choice IDs.` } };
  }
  const expectedIds = new Set(choices.map((c) => c.id).filter((x): x is number => typeof x === "number"));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of value) {
    const id = coerceInteger(v);
    if (id === null || !expectedIds.has(id)) {
      return {
        error: { field: "value", message: `Ranking contains invalid or non-existent choice ID: ${JSON.stringify(v)}` },
      };
    }
    if (seen.has(id)) {
      return { error: { field: "value", message: `Ranking contains duplicate choice ID: ${id}` } };
    }
    seen.add(id);
    out.push(id);
  }
  if (out.length !== expectedIds.size) {
    return {
      error: {
        field: "value",
        message: `Ranking must include all ${expectedIds.size} choices; got ${out.length}.`,
      },
    };
  }
  return { answer: { type: "ranking", orderedChoiceIds: out } };
}

// --- Matrix validators -----------------------------------------------------

function validateMatrixIdMap(
  value: unknown,
  question: Question,
  type: "matrix_single" | "matrix_dropdown",
): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError(type);
  }
  const rows: Record<string, number> = {};
  let missing = 0;
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (v === undefined || v === null) {
      missing += 1;
      continue;
    }
    const id = coerceInteger(Array.isArray(v) ? v[0] : v);
    if (id === null) {
      return { error: { field: `rows.${rowId}`, message: `Could not coerce ID from: ${JSON.stringify(v)}` } };
    }
    rows[String(rowId)] = id;
  }
  if (missing > 0) {
    return {
      error: { field: "value", message: `${missing} matrix row(s) missing answers.` },
      answer: type === "matrix_single" ? { type, rows } : { type, rows },
    };
  }
  return { answer: type === "matrix_single" ? { type: "matrix_single", rows } : { type: "matrix_dropdown", rows } };
}

function validateMatrixIdArrayMap(value: unknown, question: Question): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError("matrix_multiple");
  }
  const rows: Record<string, number[]> = {};
  let missing = 0;
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (v === undefined || v === null) {
      missing += 1;
      continue;
    }
    const arr = Array.isArray(v) ? v : [v];
    const ids: number[] = [];
    for (const x of arr) {
      const id = coerceInteger(x);
      if (id === null) {
        return { error: { field: `rows.${rowId}`, message: `Could not coerce ID from: ${JSON.stringify(x)}` } };
      }
      ids.push(id);
    }
    if (ids.length === 0) {
      return { error: { field: `rows.${rowId}`, message: `Multi-answer row must have at least 1 selection.` } };
    }
    rows[String(rowId)] = ids;
  }
  if (missing > 0) {
    return {
      error: { field: "value", message: `${missing} matrix row(s) missing answers.` },
      answer: { type: "matrix_multiple", rows },
    };
  }
  return { answer: { type: "matrix_multiple", rows } };
}

function validateMatrixCellsText(value: unknown, question: Question): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError("matrix_text");
  }
  const rows: Record<string, Array<{ columnId: number; text: string }>> = {};
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (!isPlainObject(v)) continue;
    const cells: Array<{ columnId: number; text: string }> = [];
    for (const [colId, text] of Object.entries(v)) {
      const id = coerceInteger(colId);
      if (id === null || typeof text !== "string") continue;
      cells.push({ columnId: id, text: text.trim() });
    }
    if (cells.length > 0) rows[String(rowId)] = cells;
  }
  if (Object.keys(rows).length === 0) {
    return { error: { field: "value", message: `No usable text cells found.` } };
  }
  return { answer: { type: "matrix_text", rows } };
}

function validateMatrixCellsRating(
  value: unknown,
  question: Question,
  scale: { min: number; max: number },
): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError("matrix_rating");
  }
  const rows: Record<string, Array<{ columnId: number; value: number }>> = {};
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (!isPlainObject(v)) continue;
    const cells: Array<{ columnId: number; value: number }> = [];
    for (const [colId, raw] of Object.entries(v)) {
      const id = coerceInteger(colId);
      const n = coerceInteger(raw);
      if (id === null || n === null) continue;
      if (n < scale.min || n > scale.max) {
        return {
          error: {
            field: `rows.${rowId}.${colId}`,
            message: `Rating ${n} outside scale ${scale.min}–${scale.max}.`,
          },
        };
      }
      cells.push({ columnId: id, value: n });
    }
    if (cells.length > 0) rows[String(rowId)] = cells;
  }
  if (Object.keys(rows).length === 0) {
    return { error: { field: "value", message: `No usable rating cells found.` } };
  }
  return { answer: { type: "matrix_rating", rows } };
}

// Use the column extractor when validating dropdowns inside matrix questions
// (each column may have its own choices). Currently consumed only by the
// builder in 5c, but exposed here so the validator's downstream consumers
// don't need to import a second symbol.
void extractQuestionColumns;

/**
 * Surface a clear error when the question shape lacks rows we expected to
 * find. Differs from the "rows missing answers" error: this means SS's GET
 * response didn't surface row metadata at any of the paths we probe.
 * Retrying won't help; the run continues with an empty answer for this
 * question and the persona-warning surfaces the cause.
 */
function rowsMissingError(
  expectedType:
    | "matrix_single"
    | "matrix_multiple"
    | "matrix_dropdown"
    | "matrix_text"
    | "matrix_rating"
    | "group_rating"
    | "constant_sum",
): ValidateOneResult {
  return {
    error: {
      field: "rows",
      message: `Question expected ${expectedType} rows but the SurveySparrow GET response surfaced none. Survey shape may differ — check questions endpoint.`,
    },
  };
}

// --- Group rating + Constant sum -------------------------------------------

function validateGroupRating(
  value: unknown,
  question: Question,
  scale: { min: number; max: number },
  archetype: SentimentArchetype,
): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError("group_rating");
  }
  const rows: Record<string, number> = {};
  let missing = 0;
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (v === undefined || v === null) {
      missing += 1;
      continue;
    }
    const n = coerceInteger(v);
    if (n === null) {
      return { error: { field: `rows.${rowId}`, message: `Expected integer rating.` } };
    }
    if (n < scale.min || n > scale.max) {
      return { error: { field: `rows.${rowId}`, message: `Rating ${n} outside scale ${scale.min}–${scale.max}.` } };
    }
    rows[String(rowId)] = n;
  }
  if (missing > 0) {
    return {
      error: { field: "value", message: `${missing} group-rating row(s) missing.` },
      answer: { type: "group_rating", rows, scale },
    };
  }
  // Light sentiment alignment: nudge the average toward the persona's range.
  // Strict alignment row-by-row would be too brittle for compound questions,
  // so we just check that the average is broadly compatible.
  const values = Object.values(rows);
  if (values.length > 0) {
    const avg = values.reduce((s, n) => s + n, 0) / values.length;
    const range = SENTIMENT_RANGES[archetype].rating;
    const span = scale.max - scale.min;
    const minAvg = scale.min + range.min * span - 0.5;
    const maxAvg = scale.min + range.max * span + 0.5;
    if (avg < minAvg || avg > maxAvg) {
      return {
        error: {
          field: "rows",
          message: `Group-rating average ${avg.toFixed(1)} doesn't match ${archetype} archetype.`,
        },
        answer: { type: "group_rating", rows, scale },
      };
    }
  }
  return { answer: { type: "group_rating", rows, scale } };
}

function validateConstantSum(value: unknown, question: Question): ValidateOneResult {
  if (!isPlainObject(value)) {
    return { error: { field: "value", message: `Expected object keyed by row ID.` } };
  }
  const totalSum = extractConstantSumTotal(question);
  const rowIds = extractQuestionRows(question).map((r) => r.id);
  if (rowIds.length === 0) {
    return rowsMissingError("constant_sum");
  }
  const rows: Record<string, number> = {};
  let sum = 0;
  for (const rowId of rowIds) {
    const v = (value as Record<string, unknown>)[String(rowId)];
    if (v === undefined || v === null) {
      return { error: { field: `rows.${rowId}`, message: `Constant-sum row is missing.` } };
    }
    const n = coerceInteger(v);
    if (n === null || n < 0) {
      return { error: { field: `rows.${rowId}`, message: `Expected non-negative integer.` } };
    }
    rows[String(rowId)] = n;
    sum += n;
  }
  if (sum !== totalSum) {
    return {
      error: {
        field: "rows",
        message: `Constant-sum values total ${sum}; expected exactly ${totalSum}.`,
      },
      answer: { type: "constant_sum", rows, totalSum },
    };
  }
  return { answer: { type: "constant_sum", rows, totalSum } };
}

// ---------------------------------------------------------------------------
// Question metadata extractors (kept tolerant — SS shapes vary)
// ---------------------------------------------------------------------------
//
// Row extraction now lives in `lib/surveysparrow/types.ts::extractQuestionRows`
// — it probes every observed location (q.row, q.properties.row,
// q.properties.data.row) and returns positional fallback IDs if rows are
// present but un-IDed.

function extractConstantSumTotal(q: Question): number {
  const data = q.properties?.data;
  if (!data || typeof data !== "object") return 100;
  const d = data as Record<string, unknown>;
  return typeof d.total_sum === "number" ? d.total_sum : 100;
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Error summarizer for retry prompts
// ---------------------------------------------------------------------------

export function summarizeResponseValidationErrors(errors: ResponseValidationError[]): string {
  if (errors.length === 0) return "";
  const sample = errors.slice(0, 4).map((e) => `Q${e.questionId}.${e.field}: ${e.message}`);
  if (errors.length > 4) sample.push(`(+${errors.length - 4} more)`);
  return sample.join(" | ");
}

// Re-export so we don't expose `inferAnswerType` from two places.
export { inferAnswerType };
