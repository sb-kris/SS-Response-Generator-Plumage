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
import { computeShownQuestions } from "@/lib/surveysparrow/display-logic";
import { inferAnswerType } from "@/lib/llm/prompts/response-prompt";
import { injectMissingRequiredGatedAnswers } from "@/lib/generation/cascade-injector";

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

  // -------------------------------------------------------------------
  // Display-logic post-filter (phase: display-logic-respect, generation)
  // -------------------------------------------------------------------
  //
  // SurveySparrow surveys can hide questions conditionally — e.g. a
  // "What went wrong?" follow-up that only shows to detractors. The
  // prompt and validator both treat every answerable question as
  // required-if-required, so a Promoter who correctly omits these
  // questions (or returns an empty multi-choice array) racks up
  // validation errors → retries → best-effort fallback. The push-time
  // filter then drops those answers anyway, so the warnings are pure
  // noise.
  //
  // Here we compute the shown-set ONCE from the answers we just
  // collected, then drop errors AND best-effort answers for questions
  // that wouldn't have been shown to this persona. The persona's other
  // answers are the source of truth for evaluating each gate
  // (chained logic handled by computeShownQuestions's order-aware walk).
  //
  // Conservative on uncertainty: if a gating question's answer is
  // missing (LLM didn't return it / it failed validation), evaluateLogic
  // returns false → the dependent question is treated as hidden → its
  // errors are dropped. This mirrors push-time behavior so the two
  // stages agree.
  if (input.questions.length > 0 && hasAnyDisplayLogic(input.questions)) {
    // Cascade injection FIRST, before the post-filter. Models consistently
    // skip multi-select gated questions even with optimal prompt wording —
    // the cascade-injector fills required gated questions whose gate is
    // satisfied by the persona's other answers, in dependency order. If
    // the LLM already generated downstream answers (e.g. opinion-scale
    // ratings for specific venues) those would be dropped by the
    // post-filter when the gateway is missing; injecting the gateway here
    // means those downstream answers survive instead. See
    // lib/generation/cascade-injector.ts for the algorithm + scope of
    // what gets synthesised vs. left alone (text answers are never
    // fabricated).
    const injection = injectMissingRequiredGatedAnswers(
      input.persona,
      answers,
      input.questions,
    );
    if (injection.injectedCount > 0) {
      // Replace the answer map with the injected version. Note: injector
      // doesn't mutate the input map, so we copy back here.
      for (const [k, v] of Object.entries(injection.answers)) {
        answers[k] = v;
      }
      // Any errors we already collected for a question we just injected
      // are stale — drop them so the orchestrator doesn't trigger
      // pointless retries. Using a Set keeps this O(errors+injected).
      const injectedSet = new Set(injection.injectedQuestionIds.map(String));
      for (let i = errors.length - 1; i >= 0; i--) {
        if (injectedSet.has(errors[i]!.questionId)) errors.splice(i, 1);
      }
      warnings.push(
        `Cascade injector synthesised ${injection.injectedCount} required gated answer(s) for ${input.persona.firstName}: ${injection.injectedQuestionIds.slice(0, 5).join(", ")}${injection.injectedQuestionIds.length > 5 ? ` (+${injection.injectedQuestionIds.length - 5} more)` : ""}.`,
      );
    }

    const answerMap = toAnswerMapById(answers);
    const shown = computeShownQuestions(input.questions, {
      answersByQuestionId: answerMap,
      variableValues: input.persona.variableValues,
    });
    const filteredErrors: ResponseValidationError[] = [];
    for (const e of errors) {
      const qidNum = parseInt(e.questionId, 10);
      // Non-question-scoped errors (e.g. "Output is not an object") keep.
      if (!Number.isFinite(qidNum)) {
        filteredErrors.push(e);
        continue;
      }
      if (shown.has(qidNum)) {
        // The question's visibility gate IS satisfied by the persona's
        // other answers. If this is a "missing" or "empty multi-choice"
        // error, rewrite it into a hyper-specific retry directive — the
        // LLM otherwise treats `Conditional` as a soft hint and defaults
        // to skip, especially on multi-select gates. We saw a 0/20
        // selection rate on Fontainebleau's area-picker even with
        // positive-framed prompt instructions; abstract rules aren't
        // enough — the retry needs to spell out WHICH gate is satisfied,
        // WHICH choice IDs are valid, and HOW MANY to pick.
        const augmented = augmentGatedRequiredError(
          e,
          questionsById.get(e.questionId),
          answerMap,
        );
        filteredErrors.push(augmented);
      }
      // else: this question wouldn't have been shown to the persona —
      // its error is moot. Drop silently.
    }
    // Also drop best-effort answers we accidentally stored for hidden
    // questions (e.g. clamped multi-choice we no longer want). Push-time
    // would have filtered these too, but keeping the validator's output
    // tidy avoids confusing preview displays.
    for (const qidStr of Object.keys(answers)) {
      const qidNum = parseInt(qidStr, 10);
      if (Number.isFinite(qidNum) && !shown.has(qidNum)) {
        delete answers[qidStr];
      }
    }
    return {
      ok: filteredErrors.length === 0,
      answers,
      errors: filteredErrors,
      warnings,
    };
  }

  return {
    ok: errors.length === 0,
    answers,
    errors,
    warnings,
  };
}

// Quick check used to skip the shown-set computation entirely when the
// survey has no conditional questions — saves a survey-order sort + walk
// on every validation call. Most surveys won't have any.
function hasAnyDisplayLogic(questions: Question[]): boolean {
  for (const q of questions) {
    if (q.display_logic?.logics && q.display_logic.logics.length > 0) return true;
  }
  return false;
}

// computeShownQuestions wants a Map<number, AnswerValue>; the validator
// stores answers keyed by string id. Tiny adapter.
function toAnswerMapById(answers: Record<string, AnswerValue>): Map<number, AnswerValue> {
  const m = new Map<number, AnswerValue>();
  for (const [k, v] of Object.entries(answers)) {
    const n = parseInt(k, 10);
    if (Number.isFinite(n)) m.set(n, v);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Gate-satisfied retry directive
// ---------------------------------------------------------------------------
//
// Models systematically skip multi-select questions that sit behind a
// display_logic gate, even with positive-framed prompt instructions
// ("Conditional ≠ optional"). In testing against the Fontainebleau survey
// the LLM picked "Yes, continue" at 100% rate but selected ZERO areas in
// the immediately-following required multi-select gate — every single
// time. Generic "Required question is missing from output" retry messages
// don't break that prior; the model needs the gate's satisfaction made
// concrete in front of it, plus the valid IDs, plus a pick recommendation.
//
// This helper rewrites a "missing" or "empty-array" error for a
// gate-satisfied conditional question into a structured retry directive.
// summarizeResponseValidationErrors keeps the first 4 errors verbatim, so
// the rewritten message flows through to the retry prompt unchanged.

function augmentGatedRequiredError(
  e: ResponseValidationError,
  question: Question | undefined,
  answersByQuestionId: Map<number, AnswerValue>,
): ResponseValidationError {
  if (!question) return e;
  const logic = question.display_logic;
  if (!logic?.logics || logic.logics.length === 0) return e;

  // Only augment the failure modes we observe in production:
  //   (a) "Required question is missing from output." — LLM omitted entirely
  //   (b) "Multi-choice answer must include at least 1 option." — empty []
  //   (c) "Expected array of choice IDs." — wrong shape
  // Other errors (e.g. invalid choice ID, range violations) already include
  // actionable context from the per-type validators.
  const isMissing = e.message === "Required question is missing from output.";
  const isEmptyMulti = e.message === "Multi-choice answer must include at least 1 option.";
  const isWrongShape = /^Expected array of choice IDs\./.test(e.message);
  if (!isMissing && !isEmptyMulti && !isWrongShape) return e;

  const display = extractQuestionDisplay(question);
  const parts: string[] = [];
  parts.push(`Required gated question "${display.text}" was not answered.`);

  // Describe which prior answers satisfy the gate so the LLM SEES the
  // implication of its own earlier picks.
  const satisfiedClauses: string[] = [];
  for (const c of logic.logics) {
    if (c.type !== "question" || c.question_id == null) continue;
    const upstreamAnswer = answersByQuestionId.get(c.question_id);
    if (!upstreamAnswer) continue;
    if (c.comparator === "isSelected" && c.choice_id != null) {
      satisfiedClauses.push(
        `you answered Q${c.question_id} including choice id ${c.choice_id}`,
      );
    } else if (c.comparator === "equals" && c.value != null) {
      satisfiedClauses.push(
        `you answered Q${c.question_id} as ${JSON.stringify(c.value)}`,
      );
    }
  }
  if (satisfiedClauses.length > 0) {
    parts.push(`GATE IS SATISFIED: ${satisfiedClauses.join(" AND ")}.`);
  }

  // Enumerate valid choice IDs (multi/single choice case) so the retry
  // prompt has them right next to the error — no hunting back through
  // the QUESTIONS block.
  const choices = display.choices ?? [];
  if (choices.length > 0) {
    const sample = choices.slice(0, 12).map((c) => `${c.id} (${truncate(c.text, 40)})`);
    const extra = choices.length > 12 ? ` …+${choices.length - 12} more` : "";
    parts.push(`Valid choice IDs: ${sample.join(", ")}${extra}.`);
  }

  // Concrete pick recommendation for the most common case (multi-select
  // gate). Keeps the directive short but unambiguous. `multiple_answers`
  // isn't on the public Question type; the prompt code reads it via the
  // same assertion, so we mirror that pattern here.
  const isMultiSelect =
    (question as unknown as { multiple_answers?: unknown }).multiple_answers === true;
  if (isMultiSelect && choices.length >= 2) {
    const target = Math.min(4, Math.max(2, Math.ceil(choices.length / 2)));
    parts.push(
      `Pick 2–${target} of the choice IDs and emit "${question.id}": [<ids>]. Do NOT return empty array, null, or omit the key.`,
    );
  } else if (choices.length >= 1) {
    parts.push(
      `Pick ONE of the choice IDs and emit "${question.id}": [<id>].`,
    );
  } else {
    parts.push(
      `Provide a non-empty answer for "${question.id}". Do NOT omit.`,
    );
  }

  return { ...e, message: parts.join(" ") };
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
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
  // Column ID enforcement (phase: matrix-likert-choice-ids):
  // SS rejects matrix answers whose IDs aren't in the question's actual
  // column set with the generic "Invalid value passed or missing values
  // in payload" error. We catch that locally so the retry loop can fix
  // it instead of shipping a failing payload. Empty validIds (e.g.
  // workspaces where extractQuestionColumns returns []) → skip the check.
  const validIds = new Set(extractQuestionColumns(question).map((c) => c.id));
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
    if (validIds.size > 0 && !validIds.has(id)) {
      return {
        error: {
          field: `rows.${rowId}`,
          message: `Value ${id} is not a valid column ID for this matrix question. Valid IDs: ${Array.from(validIds).slice(0, 5).join(", ")}${validIds.size > 5 ? `, …(+${validIds.size - 5} more)` : ""}.`,
        },
      };
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
  // Same column-ID enforcement as the single-answer path (see comment
  // there for rationale).
  const validIds = new Set(extractQuestionColumns(question).map((c) => c.id));
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
      if (validIds.size > 0 && !validIds.has(id)) {
        return {
          error: {
            field: `rows.${rowId}`,
            message: `Value ${id} is not a valid column ID for this matrix question. Valid IDs: ${Array.from(validIds).slice(0, 5).join(", ")}${validIds.size > 5 ? `, …(+${validIds.size - 5} more)` : ""}.`,
          },
        };
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
