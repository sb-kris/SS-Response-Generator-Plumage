// Cascade injector — last-resort safety net for required gated questions.
//
// Why this module exists:
//   Plumage was generating Fontainebleau-style surveys with deep display_logic
//   chains and consistently failing to populate the conditional branches.
//   Concretely: every persona answered Q1004043884 ("3 more minutes?") with
//   "Yes" (100%) but then provided ZERO area picks for the immediately-
//   following multi-select gateway Q1004043885 ("which areas?"). With
//   Q1004043885 empty, ~30 downstream venue questions had no satisfied gate
//   and stayed empty too — demo dashboards showed 6 of 9 sections blank.
//
//   We tried four prompt-side fixes (positive Conditional framing, demo-
//   richness rule, hyper-specific retry directive, dropping Conditional
//   hints entirely). Each helped a little but none guaranteed coverage —
//   the multi-select-conditional skip prior is hard to override and varies
//   by model. So we also need a server-side safety net.
//
// What this does:
//   AFTER all LLM retries have been exhausted (or the LLM has produced a
//   "successful" but incomplete response), walk the survey questions in
//   order. For each REQUIRED question whose display_logic gate is satisfied
//   by the persona's existing answers but which has no answer recorded,
//   synthesize a plausible answer in-character and inject it. Each
//   injection may unlock NEW gated questions downstream (e.g. injecting
//   Q1004043885 picks unlocks Q1004043886 + its leaves), so we re-walk
//   until the shown-set stabilises.
//
// What we DON'T do here:
//   - Inject text/email/phone/URL/date answers. Fabricating free-form text
//     without LLM help produces obvious-fake content; we'd rather have a
//     missing optional text answer than a generic-sounding one. All "Please
//     tell us the reasons for your score" fields in the Fontainebleau
//     survey are optional anyway, so this is consistent.
//   - Inject matrix or ranking answers. These are rare as required-gated
//     questions and synthesising them coherently is non-trivial. Add later
//     if we see real cases.
//   - Override existing answers. If the LLM produced something, we keep it
//     even if odd — never silently rewrite the model's choices.
//
// Sentiment alignment:
//   Synthesised scalar values land within the sentiment band the validator
//   already enforces (promoter top-of-scale, detractor bottom). Multi-
//   select pick count is sentiment-weighted: a Promoter giving feedback
//   on 3-4 areas reads naturally; a Detractor giving feedback on 1-2 reads
//   as someone who only cared about complaining about specific touchpoints.
//
// Determinism:
//   PRNG is seeded with persona.id so the same persona always gets the
//   same injected picks. Useful for reproducible demos. Date.now() is
//   explicitly NOT used.

import type { Persona, SentimentArchetype } from "./persona-types";
import type { AnswerValue } from "./response-types";
import type { Question } from "@/lib/surveysparrow/types";
import {
  compareQuestionPositions,
  extractQuestionDisplay,
  resolveScale,
} from "@/lib/surveysparrow/types";
import { computeShownQuestions } from "@/lib/surveysparrow/display-logic";
import { inferAnswerType } from "@/lib/llm/prompts/response-prompt";
import { getQuestionTypeMeta } from "@/lib/surveysparrow/question-types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CascadeInjectionResult {
  /** Updated answer map (input map is NOT mutated; result is a fresh object). */
  answers: Record<string, AnswerValue>;
  /** Count of newly-injected answers, broken down by reason — useful for
   *  debug logs ("X required gated answers patched for persona Y"). */
  injectedCount: number;
  /** Question IDs that got an injection this run. Ordered by survey position. */
  injectedQuestionIds: number[];
}

export function injectMissingRequiredGatedAnswers(
  persona: Persona,
  answers: Record<string, AnswerValue>,
  questions: Question[],
): CascadeInjectionResult {
  // Defensive copy: callers expect the input map to be unmodified.
  const out: Record<string, AnswerValue> = { ...answers };
  const injectedQuestionIds: number[] = [];

  if (questions.length === 0) {
    return { answers: out, injectedCount: 0, injectedQuestionIds };
  }

  // Cache survey-order sort once. Use compareQuestionPositions so
  // sections are honoured — sorting by question.position alone scrambles
  // order across sections and breaks the cascade walk.
  const inOrder = [...questions].sort(compareQuestionPositions);

  // Cascade loop: each iteration may unlock new shown questions, which
  // themselves may need injection. Cap iterations to a small number to
  // guard against pathological survey shapes (we've never seen >3 levels
  // in practice; 5 is generous and bounded).
  const MAX_ITERATIONS = 5;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const shown = computeShownQuestions(questions, {
      answersByQuestionId: toAnswerMapById(out),
      variableValues: persona.variableValues,
    });

    let injectedThisPass = false;

    for (const q of inOrder) {
      // Gate must be satisfied (or question is unconditional — those land
      // in the shown-set automatically).
      if (!shown.has(q.id)) continue;
      // Never overwrite an answer the LLM produced.
      const key = String(q.id);
      if (out[key]) continue;

      // Contact-info question types (EmailInput, PhoneNumber) are marked
      // answerable:false in the question-type registry, so the LLM is
      // never asked about them. Auto-fill from the persona's known
      // contact info whenever they're shown — applies regardless of
      // required/optional, since we want demo coverage on these.
      // CRITICAL for PhoneNumber: without an answer entry, SS rejects
      // the response with "region is mandatory for Phone Number
      // question" when a PhoneNumber question is reached via gate.
      const contactSynth = synthesiseContactAnswer(q, persona);
      if (contactSynth) {
        out[key] = contactSynth;
        injectedQuestionIds.push(q.id);
        injectedThisPass = true;
        continue;
      }

      // Default safety-net path: required gated questions only. Optional
      // gated questions are left to the LLM — if it skipped them, that's
      // a legitimate "no opinion" outcome.
      if (q.is_required !== true) continue;
      if (!q.display_logic?.logics?.length) continue;

      const synthesised = synthesiseAnswer(q, persona);
      if (!synthesised) continue;

      out[key] = synthesised;
      injectedQuestionIds.push(q.id);
      injectedThisPass = true;
    }

    if (!injectedThisPass) break;
  }

  return { answers: out, injectedCount: injectedQuestionIds.length, injectedQuestionIds };
}

// ---------------------------------------------------------------------------
// Contact-info auto-fill
// ---------------------------------------------------------------------------
//
// EmailInput and PhoneNumber questions are tagged `answerable: false` in the
// question-type registry — they're treated as platform-managed contact fields,
// not LLM-generated content. As a result the LLM never sees them in the
// prompt, no answer ever gets generated, and the response-builder never emits
// an answer entry for them.
//
// That's fine when the question isn't reached, but for surveys where these
// questions sit behind display_logic (e.g. Fontainebleau: PhoneNumber gated
// on "preferred contact method = Phone"), the persona's downstream answers
// can satisfy the gate, the question becomes shown, and SS expects either
// an answer entry or no entry-but-explicit-skip. Specifically for
// PhoneNumber, SS rejects the whole response with "region is mandatory for
// Phone Number question" if it sees a survey with a PhoneNumber question
// but no matching answer entry carrying a region code.
//
// Fix: auto-fill these from the persona's pre-existing contact info.
// persona.email and persona.phone are faker-generated at persona-synthesis
// time and always present, and they're already what we send as contact info
// at the response level — so the question answer is just the same value
// repeated in answer-entry shape. Region code travels with phone answer
// entries via the response-builder's existing path.
//
// This runs regardless of the question's required/optional flag because:
//   (a) demo coverage — we always want these populated when the user reaches
//       them, not "sometimes the LLM declines"
//   (b) the LLM can't fill them anyway (answerable: false)

// Set of canonical values that the question-type registry uses to label
// email / phone questions. Both "phone" and "phonenumber" appear as
// aliases on the same Phone registry entry — depending on which alias
// matches first (e.g. "Phone" type → "phone" exact, "PhoneNumber" type
// → "phonenumber" exact), the canonical may be either. Treat both as
// equivalent for synthesis.
const EMAIL_CANONICALS = new Set(["email"]);
const PHONE_CANONICALS = new Set(["phone", "phonenumber"]);

function synthesiseContactAnswer(q: Question, persona: Persona): AnswerValue | null {
  const meta = getQuestionTypeMeta(q.type);
  if (EMAIL_CANONICALS.has(meta.canonical)) {
    return persona.email ? { type: "email", value: persona.email } : null;
  }
  if (PHONE_CANONICALS.has(meta.canonical)) {
    return persona.phone ? { type: "phone", value: persona.phone } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-type synthesis
// ---------------------------------------------------------------------------

function synthesiseAnswer(q: Question, persona: Persona): AnswerValue | null {
  const meta = getQuestionTypeMeta(q.type);
  if (!meta.answerable) return null;
  const display = extractQuestionDisplay(q);
  if (display.imageOnly) return null;
  const type = inferAnswerType(q, meta);
  if (!type) return null;

  const rng = makeRng(persona.id + "::" + q.id);
  const sentiment = persona.sentimentArchetype;

  switch (type) {
    case "multi_choice":
      return synthMultiChoice(q, display, sentiment, rng);
    case "single_choice":
    case "dropdown":
      return synthSingleChoice(type, display, rng);
    case "opinion_scale":
      return synthScaleValue("opinion_scale", q, sentiment, rng, 0, 10);
    case "rating":
      return synthScaleValue("rating", q, sentiment, rng, 1, 5);
    case "slider":
      return synthScaleValue("slider", q, sentiment, rng, 0, 100);
    case "nps":
      return { type: "nps", value: npsForSentiment(sentiment, rng) };
    case "csat":
      return { type: "csat", value: csatForSentiment(sentiment, rng) };
    case "ces":
      return { type: "ces", value: cesForSentiment(sentiment, rng) };
    case "yes_no":
      // Lean toward "yes" for demo coverage; detractors flip negative
      // a bit more often.
      return {
        type: "yes_no",
        value: sentiment === "detractor" ? rng() < 0.5 : rng() < 0.85,
      };
    // Free-form / scalar text: deliberately skipped — see module header.
    case "text":
    case "email":
    case "phone":
    case "url":
    case "date":
    case "number":
    // Complex shapes — skipped for now.
    case "ranking":
    case "matrix_single":
    case "matrix_multiple":
    case "matrix_dropdown":
    case "matrix_text":
    case "matrix_rating":
    case "group_rating":
    case "constant_sum":
      return null;
    default: {
      // Exhaustiveness check — adding a new AnswerType means revisiting
      // this switch.
      const _exhaustive: never = type;
      void _exhaustive;
      return null;
    }
  }
}

function synthMultiChoice(
  _q: Question,
  display: ReturnType<typeof extractQuestionDisplay>,
  sentiment: SentimentArchetype,
  rng: () => number,
): AnswerValue | null {
  // Keep only choices with a numeric id — the SS schema marks id as
  // optional, but practical questions always have ids. Strip the
  // hasImage field we don't need.
  const validChoices: Array<{ id: number; text: string }> = [];
  for (const c of display.choices ?? []) {
    if (typeof c.id === "number") {
      validChoices.push({ id: c.id, text: c.text });
    }
  }
  if (validChoices.length === 0) return null;

  // Pick count by sentiment:
  //   Promoter — generous, gives feedback on more areas (3-4 of 5)
  //   Passive  — moderate (2)
  //   Detractor — picky, focuses on a few sore spots (1-2)
  // Clamped to the available choice count.
  const minPick = sentiment === "promoter" ? 3 : sentiment === "passive" ? 2 : 1;
  const maxPick = sentiment === "promoter" ? 4 : sentiment === "passive" ? 3 : 2;
  const cap = Math.min(maxPick, validChoices.length);
  const floor = Math.min(minPick, cap);
  const target = floor + Math.floor(rng() * (cap - floor + 1));

  // Fisher-Yates partial shuffle to draw `target` distinct choices.
  const indices = validChoices.map((_, i) => i);
  for (let i = 0; i < target; i++) {
    const j = i + Math.floor(rng() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  const picked = indices.slice(0, target).map((i) => {
    const c = validChoices[i]!;
    return { id: c.id, label: c.text };
  });
  return { type: "multi_choice", choices: picked };
}

function synthSingleChoice(
  type: "single_choice" | "dropdown",
  display: ReturnType<typeof extractQuestionDisplay>,
  rng: () => number,
): AnswerValue | null {
  // Keep only choices with a numeric id — the SS schema marks id as
  // optional, but practical questions always have ids. Strip the
  // hasImage field we don't need.
  const validChoices: Array<{ id: number; text: string }> = [];
  for (const c of display.choices ?? []) {
    if (typeof c.id === "number") {
      validChoices.push({ id: c.id, text: c.text });
    }
  }
  if (validChoices.length === 0) return null;
  // Demo-richness bias: if there's exactly 2 choices and one looks like a
  // "yes/continue" answer, lean toward picking it. Recognised by a few
  // common label substrings.
  if (validChoices.length === 2) {
    const expandIdx = validChoices.findIndex((c) =>
      /^(yes|continue|sure|absolutely|i'?d like to)/i.test(c.text.trim()),
    );
    if (expandIdx !== -1 && rng() < 0.75) {
      const picked = validChoices[expandIdx]!;
      return type === "single_choice"
        ? { type: "single_choice", choiceId: picked.id, choiceLabel: picked.text }
        : { type: "dropdown", choiceId: picked.id, choiceLabel: picked.text };
    }
  }
  const picked = validChoices[Math.floor(rng() * validChoices.length)]!;
  return type === "single_choice"
    ? { type: "single_choice", choiceId: picked.id, choiceLabel: picked.text }
    : { type: "dropdown", choiceId: picked.id, choiceLabel: picked.text };
}

function synthScaleValue(
  type: "opinion_scale" | "rating" | "slider",
  q: Question,
  sentiment: SentimentArchetype,
  rng: () => number,
  defaultMin: number,
  defaultMax: number,
): AnswerValue {
  const scale = resolveScale(q, defaultMin, defaultMax);
  const value = scaleValueForSentiment(scale, sentiment, rng);
  if (type === "opinion_scale") return { type, value, scale };
  if (type === "slider") return { type, value, scale };
  return { type, value, scale };
}

// ---------------------------------------------------------------------------
// Sentiment-banded value pickers
// ---------------------------------------------------------------------------
//
// These mirror (and stay within) the validator's `SENTIMENT_RATING_BANDS`
// so synthesised values never trip a "sentiment mismatch" complaint on
// the next round-trip.

function scaleValueForSentiment(
  scale: { min: number; max: number },
  sentiment: SentimentArchetype,
  rng: () => number,
): number {
  const span = scale.max - scale.min;
  let lowFrac: number;
  let highFrac: number;
  switch (sentiment) {
    case "promoter":
      lowFrac = 0.8;
      highFrac = 1.0;
      break;
    case "passive":
      lowFrac = 0.45;
      highFrac = 0.7;
      break;
    case "detractor":
    default:
      lowFrac = 0.0;
      highFrac = 0.4;
      break;
  }
  const lo = scale.min + Math.floor(span * lowFrac);
  const hi = scale.min + Math.floor(span * highFrac);
  return Math.max(scale.min, Math.min(scale.max, lo + Math.floor(rng() * (hi - lo + 1))));
}

function npsForSentiment(sentiment: SentimentArchetype, rng: () => number): number {
  switch (sentiment) {
    case "promoter":
      return 9 + Math.floor(rng() * 2); // 9-10
    case "passive":
      return 7 + Math.floor(rng() * 2); // 7-8
    case "detractor":
    default:
      return Math.floor(rng() * 7); // 0-6
  }
}

function csatForSentiment(sentiment: SentimentArchetype, rng: () => number): number {
  switch (sentiment) {
    case "promoter":
      return 4 + Math.floor(rng() * 2); // 4-5
    case "passive":
      return 3;
    case "detractor":
    default:
      return 1 + Math.floor(rng() * 2); // 1-2
  }
}

function cesForSentiment(sentiment: SentimentArchetype, rng: () => number): number {
  switch (sentiment) {
    case "promoter":
      return 6 + Math.floor(rng() * 2); // 6-7
    case "passive":
      return 4 + Math.floor(rng() * 2); // 4-5
    case "detractor":
    default:
      return 1 + Math.floor(rng() * 3); // 1-3
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAnswerMapById(answers: Record<string, AnswerValue>): Map<number, AnswerValue> {
  const m = new Map<number, AnswerValue>();
  for (const [k, v] of Object.entries(answers)) {
    const n = parseInt(k, 10);
    if (Number.isFinite(n)) m.set(n, v);
  }
  return m;
}

// Tiny seeded PRNG (mulberry32-style). String seed is folded into a 32-bit
// integer via a stable hash so injected picks are reproducible across runs
// for the same persona. Date.now() and Math.random() are deliberately not
// used — those would make demo regeneration non-reproducible and would
// also break workflow journals if this ever runs inside one.
function makeRng(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
