// Phase 5c — Maps Plumage's internal AnswerValue format to the SS v3
// POST /v3/responses/batch wire format (verified against API docs May 2026).
//
// Key rules from the docs:
//   - Top-level metadata goes in `meta_data`, NOT as flat fields.
//   - Contact (full_name / email / phone) goes inside each response item —
//     only available on the batch endpoint.
//   - Grouped sub-questions (GroupRating statements, Matrix rows,
//     ConstantSum items) require `parent_question_id` on every answer entry.
//   - Matrix TEXT_INPUT uses `answer: [colId…]` + `matrix_txt: [text…]`.
//   - Matrix RATING uses `answer: [colId…]` + `matrix_int: [val…]`.
//   - Phone answers require `region_code` (ISO 3166-1 alpha-2).
//   - `trigger_workflow: false` keeps demo imports from firing automation rules.

import type { GeneratedResponse, AnswerValue } from "@/lib/generation/response-types";
import type { Persona } from "@/lib/generation/persona-types";
import type { Question } from "@/lib/surveysparrow/types";
import { computeShownQuestions } from "@/lib/surveysparrow/display-logic";

// Safety-net denylist — variable names we always strip from the response
// `variables` block, regardless of whether the readiness check detected
// them as persona-bound. Catches workspaces where the /v3/variables
// endpoint doesn't reveal the binding shape (so detection returns no
// hits) but the variable is wired to a persona field internally.
//
// Why these specific names: every one of them is a standard SurveySparrow
// persona binding per their docs / dashboard taxonomy. If a custom
// STRING-typed variable with one of these names exists, the auto-populate
// would have overridden our value anyway — so dropping it from the
// payload is a no-op for correctness and a fix for cases where SS would
// otherwise reject the response.
const PERSONA_BINDING_NAME_FALLBACKS: ReadonlySet<string> = new Set([
  "first_name",
  "last_name",
  "full_name",
  "email",
  "customer_email",
  "contact_email",
  "contact_first_name",
  "contact_last_name",
  "phone",
  "phone_number",
  "contact_phone",
]);

// ---------------------------------------------------------------------------
// Wire format types
// ---------------------------------------------------------------------------

export interface SSAnswerEntry {
  question_id: number;
  /** Required for sub-questions (Matrix rows, GroupRating statements, etc.) */
  parent_question_id?: number;
  answer: unknown;
  /** Matrix TEXT_INPUT — column text values (parallel to `answer` column IDs) */
  matrix_txt?: string[];
  /** Matrix RATING — column rating values (parallel to `answer` column IDs) */
  matrix_int?: number[];
  /** PhoneNumber — ISO 3166-1 alpha-2 country code */
  region_code?: string;
  /** DateTime — IANA timezone (e.g. "Asia/Calcutta") */
  time_zone?: string;
}

// ---------------------------------------------------------------------------
// Push options (passed from usePushResponses → buildSSBatchPayload)
// ---------------------------------------------------------------------------

export interface PushChannelConfig {
  channelId: number;
  weight: number;
}

export interface PushOptions {
  triggerWorkflow?: boolean;
  /** When non-empty, each response is routed to a channel via weighted random. */
  channels?: PushChannelConfig[];
  /** When non-empty, added to every response's meta_data.tags. */
  tags?: string[];
  /**
   * Map from question id → `{min, max}` of the question's actual scale.
   * Used to clamp out-of-range rating / opinion-scale / slider values
   * BEFORE we ship them to SurveySparrow. SS rejects out-of-range values
   * with a generic "Invalid value passed or missing values in payload"
   * error — and the LLM occasionally drifts past the scale max when the
   * validator's resolved scale is wider than SS's actual config (e.g.
   * "passive NPS 7-8" applied to a 0-7 question yields 8 = invalid).
   * Clamping defensively at push time means even partial validator misses
   * don't surface as SS rejects.
   */
  questionScales?: Map<number, { min: number; max: number }>;
  /**
   * Map from a question's id → its `parent_question_id` (when set on the SS
   * question). Used to populate `parent_question_id` on answer entries for
   * follow-up question types like `NPSFeedback`, which SS silently drops if
   * pushed without the parent reference (symptom: the follow-up question
   * shows "Not Answered" in the SS UI even though we sent text for it).
   *
   * Caller builds this from the survey-store's questions list. Matrix /
   * group-rating rows aren't included here because those already get
   * `parent_question_id` set explicitly inside the converter — they're
   * sub-rows whose qid IS the row id, not the parent.
   */
  questionParents?: Map<number, number>;
  /**
   * Full question list for the survey, used to evaluate display_logic /
   * jump_logic at push time. When supplied, each persona's answer set is
   * filtered so questions whose conditional logic would have HIDDEN them
   * from this persona never make it into the SS payload — mirroring what
   * a real respondent would have experienced.
   *
   * If omitted (or empty), no logic filtering happens — every LLM answer
   * is pushed as-is. Useful for surveys with no conditional questions
   * and as a safety net when the survey-store hasn't populated the
   * questions data yet.
   *
   * Note: a question is only filtered when display_logic is present AND
   * its conditions definitively fail for the persona. Unknown comparators
   * or malformed logic blocks default to "show", so dropping is
   * conservative.
   */
  questions?: Question[];
  /**
   * Optional callback invoked once per persona with stats about how many
   * answers were kept vs dropped by display_logic. Used by the push hook
   * to surface a debug-log line ("Batch 2: 7 conditional answers
   * skipped") so the user can see the feature is working without diffing
   * payloads.
   */
  onLogicFiltered?: (stats: { personaName: string; kept: number; dropped: number }) => void;
  /**
   * Lowercased variable names that must NOT appear in each response's
   * `variables` block. Used to drop persona-bound variables (FIRST_NAME,
   * LAST_NAME, CUSTOMER_EMAIL, etc.) — SurveySparrow auto-populates those
   * from the response's contact info, and rejects the entire response
   * with "Invalid value passed or missing values in payload" if we
   * include explicit values.
   *
   * Sourced from ensureSurveyVariablesExist().excludeFromPayload at push
   * time, so the list reflects whatever's actually configured on the SS
   * workspace.
   */
  excludeVariableNames?: string[];
  /**
   * Lowercased names of variables whose SS type is "DATE". Values for
   * these keys are reformatted to MM-DD-YYYY (dashes, NOT slashes)
   * before serialisation — the format SS's response-batch endpoint
   * accepts. Confirmed via the SS engineering team + Postman probe
   * 2026-06-01: every other format we tested returned "Custom
   * Property not found" (YYYY-MM-DD, YYYY/MM/DD, ISO 8601 datetime,
   * epoch ms, DDMMYYYY, MMDDYYYY slashed — all failed).
   *
   * Internal storage in Plumage stays YYYY-MM-DD (used by CSV export,
   * preview, the dashboard). The MM-DD-YYYY conversion is applied at
   * the SS-wire boundary only.
   */
  dateVariableNames?: string[];
}

export interface SSBatchResponseItem {
  contact?: {
    full_name: string;
    email?: string;
    phone?: string;
    contact_type: "contact" | "employee";
  };
  trigger_workflow: boolean;
  channel_id?: number;
  variables?: Record<string, string | number>;
  meta_data?: {
    os?: string;
    browser?: string;
    time_zone?: string;
    /** Short ISO 639-1 code (e.g. "en", "fr", "nl"). Controls the response's
     *  language assignment inside the SS platform. */
    language?: string;
    /** BCP 47 locale string (e.g. "en-US", "fr-FR"). Mirrors what a real
     *  respondent's browser would have reported. */
    browser_language?: string;
    /** ISO 8601 datetime — represents survey start time */
    date_time?: string;
    ip?: string;
    device_type?: string;
    /** Optional tags applied to the response. */
    tags?: string[];
  };
  answers: SSAnswerEntry[];
}

export interface SSBatchPayload {
  survey_id: number;
  responses: SSBatchResponseItem[];
}

// Batch endpoint returns a token to poll for completion.
export interface SSBatchSubmitResult {
  token?: string;
  message?: string;
}

export interface SSBatchStatusResult {
  /** True once SS confirms all responses were processed. */
  done: boolean;
  processed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export function buildSSBatchPayload(
  pairs: Array<{ response: GeneratedResponse; persona: Persona }>,
  surveyId: number,
  options?: PushOptions,
): SSBatchPayload {
  return {
    survey_id: surveyId,
    responses: pairs.map(({ response, persona }) => buildBatchItem(response, persona, options)),
  };
}

function buildBatchItem(
  response: GeneratedResponse,
  persona: Persona,
  options?: PushOptions,
): SSBatchResponseItem {
  const answers: SSAnswerEntry[] = [];
  const parentMap = options?.questionParents;
  const scalesMap = options?.questionScales;

  // --------------------------------------------------------------
  // Display-logic filter (phase: display-logic-respect)
  // --------------------------------------------------------------
  //
  // Build a map of the persona's answers keyed by question id, then ask
  // the evaluator which questions would actually have been shown given
  // those answers + the persona's variable values. Only answers for
  // shown questions land in the push payload.
  //
  // Notes:
  //   • The shown-set is per-persona — chained logic ("show Q3 only if Q2
  //     was answered with X") evaluates correctly because the evaluator
  //     walks questions in survey order, only considering answers from
  //     already-confirmed-shown upstream questions.
  //   • Matrix / GroupRating / ConstantSum sub-rows aren't first-class
  //     questions in the survey list — only their parents are. So we
  //     filter at the PARENT level; if a parent passes, all its rows
  //     go through. Today SS doesn't surface display_logic on row-level
  //     entities anyway, so this matches the platform's behavior.
  //   • Follow-up children (NPSFeedback) ARE in the questions list with
  //     parent_question_id set. Their display_logic (if any) is evaluated
  //     normally; if SS didn't set explicit logic they default to shown.
  //
  // If no questions list was supplied, every question is considered
  // shown (legacy behavior — no filtering).
  let shownSet: Set<number> | null = null;
  if (options?.questions && options.questions.length > 0) {
    const answersByQid = new Map<number, AnswerValue>();
    for (const [qidStr, answer] of Object.entries(response.answers)) {
      const qid = parseInt(qidStr, 10);
      if (Number.isFinite(qid)) answersByQid.set(qid, answer);
    }
    shownSet = computeShownQuestions(options.questions, {
      answersByQuestionId: answersByQid,
      variableValues: persona.variableValues,
    });
  }

  let kept = 0;
  let dropped = 0;

  for (const [qidStr, answer] of Object.entries(response.answers)) {
    const qid = parseInt(qidStr, 10);
    if (!Number.isFinite(qid)) continue;
    // If we have a shown-set, skip questions that aren't in it. Questions
    // not present in the survey list at all (defensive: orphan answer
    // for an unknown qid) are also skipped — better to drop than push
    // an answer SS will reject.
    if (shownSet !== null && !shownSet.has(qid)) {
      dropped++;
      continue;
    }
    kept++;
    for (const entry of convertAnswer(qid, answer, persona)) {
      // For top-level questions that are themselves children of a parent
      // (NPSFeedback → NPSScore is the canonical case), populate the
      // entry's `parent_question_id` from the question metadata. Matrix /
      // group-rating sub-row entries already have their own
      // `parent_question_id` set by the converter — we don't overwrite.
      if (entry.parent_question_id == null) {
        const parent = parentMap?.get(qid);
        if (parent != null) {
          entry.parent_question_id = parent;
        }
      }

      // Defensive: clamp + round numeric answers to the question's actual scale.
      // SS rejects any value outside the configured min/max with a
      // generic "Invalid value passed or missing values in payload"
      // error, AND rejects non-integer answers for rating-style questions
      // (NPS, CSAT, rating, opinion_scale, slider). The validator
      // enforces this at generation time, but the LLM occasionally emits
      // 3.8 / 2.6 / etc. — clamping + rounding here is the last-mile
      // guarantee that the payload stays both in-range and integer-typed
      // for whole-number scales.
      if (
        scalesMap &&
        typeof entry.answer === "number" &&
        !Array.isArray(entry.answer)
      ) {
        // Local copy keeps TS's number-narrowing across the clamp+round.
        // `entry.answer` is typed `unknown` on SSAnswerEntry; reassigning
        // through it loses the narrowing the typeof guard established.
        let n: number = entry.answer;
        const scale = scalesMap.get(qid);
        if (scale) {
          if (n < scale.min) n = scale.min;
          else if (n > scale.max) n = scale.max;
        }
        // Round to integer when the scale uses integer endpoints — which
        // is true for every rating-style SS question we generate for
        // (NPS 0-10, CSAT 1-5, opinion_scale 1-N). Sliders that genuinely
        // allow decimals are rare and would still round to the nearest
        // integer here; if a workspace needs decimals we'd track this
        // via question metadata instead.
        if (!Number.isInteger(n)) {
          n = Math.round(n);
        }
        entry.answer = n;
      }

      answers.push(entry);
    }
  }

  // Surface per-persona logic stats to the caller (push hook) — used to
  // log a single "N conditional answers skipped" line per batch. Only
  // fires when filtering actually happened.
  if (shownSet !== null && options?.onLogicFiltered) {
    options.onLogicFiltered({ personaName: persona.name, kept, dropped });
  }

  // date_time in meta_data = survey start (submit minus random 2–10 min).
  const submitMs = new Date(persona.submittedAt).getTime();
  const startMs = submitMs - (2 + Math.random() * 8) * 60_000;

  const channelId =
    options?.channels && options.channels.length > 0
      ? pickChannel(options.channels)
      : undefined;

  const tagsForResponse: string[] = options?.tags ?? [];

  // Filter out persona-bound variables from the response payload. SS
  // auto-populates these from the contact (full_name → first_name +
  // last_name → persona.firstName / persona.lastName, email →
  // persona.email), and rejects the entire response with "Invalid value
  // passed or missing values in payload" if we include explicit values.
  //
  // Two layers of defense:
  //   1. Dynamic exclude list from the readiness check — catches whatever
  //      the SS API reveals as persona-bound for THIS workspace.
  //   2. Hardcoded safety net — common SS persona-binding names that we
  //      always strip, even if detection silently missed them. Cheap
  //      insurance: any SE writing a "first_name" custom STRING variable
  //      would still get it auto-overwritten by the persona's actual
  //      name on push, so removing it from the payload is harmless.
  // Build the exclusion set:
  //   1. Caller-supplied persona-bound names (from /v3/variables PERSONA
  //      type detection).
  //   2. Hardcoded persona-binding name fallbacks (first_name, last_name,
  //      email, etc.) — safety net for workspaces where detection misses.
  // DATE-typed names are NOT excluded — they're reformatted to MM-DD-YYYY
  // below at the SS-wire boundary (the only format SS accepts).
  const dynamicExclude = options?.excludeVariableNames ?? [];
  const excludeSet = new Set<string>([
    ...dynamicExclude.map((s) => s.toLowerCase()),
    ...PERSONA_BINDING_NAME_FALLBACKS,
  ]);
  const dateNameSet = new Set<string>(
    (options?.dateVariableNames ?? []).map((s) => s.toLowerCase()),
  );
  const filteredVariables: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(persona.variableValues)) {
    if (excludeSet.has(k.toLowerCase())) continue;
    // DATE-typed → MM-DD-YYYY (the only format SS's batch endpoint
    // accepts). Non-DATE values pass through untouched.
    filteredVariables[k] = dateNameSet.has(k.toLowerCase())
      ? formatDateVariableValue(v)
      : v;
  }
  const variablesForPayload = filteredVariables;

  return {
    contact: {
      full_name: persona.name,
      ...(persona.email ? { email: persona.email } : {}),
      // Phone at the contact level: same E.164 normalisation as the
      // answer entries. SS appears to validate contact.phone with the
      // same rules as a PhoneNumber answer, and rejects faker's
      // "+1 (...) ..." format with a generic "Invalid value" error.
      ...(persona.phone ? { phone: toE164Phone(persona.phone) } : {}),
      contact_type: "contact",
    },
    trigger_workflow: options?.triggerWorkflow ?? false,
    ...(channelId !== undefined ? { channel_id: channelId } : {}),
    ...(Object.keys(variablesForPayload).length > 0
      ? { variables: variablesForPayload }
      : {}),
    meta_data: {
      os: persona.os,
      browser: persona.browser,
      time_zone: persona.timezone,
      // `language` = bare ISO 639-1 code. This is the one SS uses to assign the
      // response to a language inside the platform. Required for non-English
      // demos to render in the respondent's language.
      language: persona.language,
      // `browser_language` = BCP 47 locale (lang-COUNTRY). Just metadata —
      // mirrors what a real browser's Accept-Language would have sent.
      browser_language: toLocaleBcp47(persona.language, persona.country),
      date_time: new Date(startMs).toISOString(),
      ...(persona.ipAddress ? { ip: persona.ipAddress } : {}),
      device_type: mapDeviceType(persona.deviceType),
      // tags: pulled from PushOptions.tags (sourced from SystemMetadataConfig.tags).
      ...(tagsForResponse.length > 0 ? { tags: tagsForResponse } : {}),
    },
    answers,
  };
}

// ---------------------------------------------------------------------------
// Answer conversion
// ---------------------------------------------------------------------------

function convertAnswer(qid: number, answer: AnswerValue, persona: Persona): SSAnswerEntry[] {
  switch (answer.type) {
    // ---- Free-text / scalars ----
    case "text":
    case "url":
    case "email":
      return [{ question_id: qid, answer: answer.value }];

    case "number":
      return [{ question_id: qid, answer: answer.value }];

    case "phone":
      return [{
        question_id: qid,
        // SS rejects faker's verbose "+1 (682) 433-1083" with a generic
        // "Invalid value passed or missing values in payload" error.
        // Normalising to E.164 (+CCNNNNNNNNNN, digits only) makes it
        // accept the same number — that's the international standard
        // most survey APIs require for phone questions.
        answer: toE164Phone(String(answer.value)),
        // region_code must be present or SS rejects with "region is
        // mandatory for Phone Number question". persona.country is set
        // by the faker layer for every persona; "US" is the safety-net
        // fallback for the rare case it's empty (mapping miss, custom
        // country filter, etc.). We never want to leave this undefined.
        region_code: persona.country || "US",
      }];

    case "date":
      // SS expects format matching the question's date_format config.
      // We store ISO dates; send as-is and include timezone.
      return [{
        question_id: qid,
        answer: answer.value,
        time_zone: persona.timezone,
      }];

    // ---- Numeric scales ----
    case "nps":
    case "csat":
    case "ces":
    case "rating":
    case "opinion_scale":
    case "slider":
      return [{ question_id: qid, answer: answer.value }];

    // ---- Boolean ----
    case "yes_no":
      return [{ question_id: qid, answer: answer.value ? "Yes" : "No" }];

    // ---- Choice questions — SS always expects an array ----
    case "single_choice":
    case "dropdown":
      return [{ question_id: qid, answer: [answer.choiceId] }];

    case "multi_choice":
      return [{ question_id: qid, answer: answer.choices.map((c) => c.id) }];

    case "ranking":
      return [{ question_id: qid, answer: answer.orderedChoiceIds }];

    // ---- Grouped: one entry per row WITH parent_question_id ----
    case "group_rating":
      return Object.entries(answer.rows).map(([rowId, val]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: val,
      }));

    case "constant_sum":
      return Object.entries(answer.rows).map(([rowId, val]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: val,
      }));

    case "matrix_single":
    case "matrix_multiple":
      return Object.entries(answer.rows).map(([rowId, ids]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: Array.isArray(ids) ? ids : [ids],
      }));

    case "matrix_dropdown":
      return Object.entries(answer.rows).map(([rowId, choiceId]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: [choiceId],
      }));

    case "matrix_text":
      return Object.entries(answer.rows).map(([rowId, cells]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: cells.map((c) => c.columnId),
        matrix_txt: cells.map((c) => c.text),
      }));

    case "matrix_rating":
      return Object.entries(answer.rows).map(([rowId, cells]) => ({
        question_id: parseInt(rowId, 10),
        parent_question_id: qid,
        answer: cells.map((c) => c.columnId),
        matrix_int: cells.map((c) => c.value),
      }));

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapDeviceType(deviceType: string): string {
  if (deviceType === "Mobile") return "MOBILE";
  if (deviceType === "Tablet") return "TABLET";
  return "COMPUTER";
}

// Default country region for each ISO 639-1 language code (BCP 47 primary region).
const LANG_DEFAULT_REGION: Record<string, string> = {
  en: "US", es: "ES", fr: "FR", de: "DE", pt: "BR", it: "IT",
  nl: "NL", ja: "JP", ko: "KR", zh: "CN", ar: "SA", ru: "RU",
  hi: "IN", tr: "TR", pl: "PL", sv: "SE", da: "DK", no: "NO",
  fi: "FI", cs: "CZ", hu: "HU", ro: "RO", uk: "UA", id: "ID",
  ms: "MY", th: "TH", vi: "VN", he: "IL",
};

// When the persona's country code is a natural match for the language,
// use "lang-COUNTRY" (e.g. en-GB, fr-BE). Otherwise fall back to the
// default region above.
const LANG_COUNTRY_COMBOS: Partial<Record<string, Set<string>>> = {
  en: new Set(["US","GB","AU","CA","NZ","IE","ZA","IN"]),
  fr: new Set(["FR","BE","CH","CA","LU","MC"]),
  de: new Set(["DE","AT","CH","LI"]),
  es: new Set(["ES","MX","AR","CO","PE","CL","VE","EC","BO","PY","UY","CR","PA","DO","GT","HN","SV","NI","CU","PR"]),
  pt: new Set(["PT","BR","AO","MZ","CV","GW","ST","TL"]),
  nl: new Set(["NL","BE","SR"]),
  zh: new Set(["CN","TW","HK","SG","MO"]),
  ar: new Set(["SA","EG","AE","MA","DZ","TN","IQ","JO","KW","QA","BH","OM","LY","SD","LB","YE","PS","SY","MR","DJ","KM"]),
};

function pickChannel(channels: PushChannelConfig[]): number | undefined {
  if (channels.length === 0) return undefined;
  const total = channels.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return channels[0]?.channelId;
  let rand = Math.random() * total;
  for (const ch of channels) {
    rand -= ch.weight;
    if (rand <= 0) return ch.channelId;
  }
  return channels[channels.length - 1]?.channelId;
}

function toLocaleBcp47(lang: string, country?: string): string {
  const l = lang.toLowerCase();
  if (country) {
    const c = country.toUpperCase();
    if (LANG_COUNTRY_COMBOS[l]?.has(c)) return `${l}-${c}`;
  }
  const def = LANG_DEFAULT_REGION[l];
  return def ? `${l}-${def}` : l;
}

// ---------------------------------------------------------------------------
// Phone wire format — E.164
// ---------------------------------------------------------------------------
//
// SurveySparrow rejects faker's verbose phone format with a generic
// "Invalid value passed or missing values in payload" error, on BOTH
// contact.phone and PhoneNumber answer entries. The shape SS expects
// is E.164: a leading "+", then country code, then national number,
// with NO spaces / parentheses / dashes.
//
// Examples (faker output → wire format):
//   "+1 (682) 433-1083" → "+16824331083"
//   "+44 12 4176 0340"   → "+441241760340"
//   "+34 925 747 719"    → "+34925747719"
//   "+91 51992 10613"    → "+915199210613"
//
// Implementation: strip everything that isn't a digit, preserve the
// leading + if the input had one. If the input had no + (which
// shouldn't happen for faker output but is defensible), we still
// strip non-digits but skip the + prefix — region_code carries the
// country information separately so SS can re-attach if needed.
function toE164Phone(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 0) return trimmed;
  return hasPlus ? `+${digits}` : digits;
}

// ---------------------------------------------------------------------------
// DATE wire format — MM-DD-YYYY
// ---------------------------------------------------------------------------
//
// SurveySparrow's /v3/responses/batch endpoint accepts DATE-typed
// Custom Property values ONLY in MM-DD-YYYY format with dashes
// (e.g. "04-21-2026" for April 21, 2026). Confirmed by the SS
// engineering team via direct code inspection 2026-06-01, then
// verified via Postman against a live workspace.
//
// Every other format we tested returns the misleading error
// "Custom Property not found":
//
//   - "2026-04-21"                  (YYYY-MM-DD dashed)
//   - "2026/04/21"                  (YYYY/MM/DD slashed)
//   - "21/04/2026"                  (DDMMYYYY slashed)
//   - "21-04-2026"                  (DDMMYYYY dashed)
//   - "04/21/2026"                  (MMDDYYYY slashed)
//   - "2026-04-21T00:00:00.000Z"    (ISO 8601 datetime, midnight)
//   - "2026-04-21T11:28:55.642Z"    (ISO 8601 datetime, real time)
//   - 1745366400000                 (epoch ms number)
//   - "1745366400000"               (epoch ms string)
//
// `formatDateVariableValue` is invoked only for variable keys the
// readiness check identified as DATE-typed on the SS workspace.
// Non-DATE values never reach this function — they pass through the
// builder untouched.

const MM_DD_YYYY_RE = /^\d{2}-\d{2}-\d{4}$/;
const YYYY_MM_DD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YYYY_SLASH_MM_DD_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const ISO_DT_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})T/;

function formatDateVariableValue(value: string | number): string | number {
  // Numbers → assume epoch ms.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    return formatEpochAsMMDDYYYY(value);
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return ""; // explicit blank stays blank

  // Already MM-DD-YYYY — pass through unchanged.
  if (MM_DD_YYYY_RE.test(trimmed)) return trimmed;

  // YYYY-MM-DD (what faker-layer emits internally) → reorder.
  const ymd = trimmed.match(YYYY_MM_DD_RE);
  if (ymd) {
    return `${ymd[2]}-${ymd[3]}-${ymd[1]}`;
  }

  // YYYY/MM/DD → reorder.
  const ymdSlash = trimmed.match(YYYY_SLASH_MM_DD_RE);
  if (ymdSlash) {
    return `${ymdSlash[2]}-${ymdSlash[3]}-${ymdSlash[1]}`;
  }

  // ISO datetime ("2026-04-21T..." or "2026-04-21T...Z") → extract date.
  const isoDt = trimmed.match(ISO_DT_PREFIX_RE);
  if (isoDt) {
    return `${isoDt[2]}-${isoDt[3]}-${isoDt[1]}`;
  }

  // Last-ditch: ask the platform Date parser. If it yields a valid
  // instant, emit MM-DD-YYYY. Otherwise leave the original value
  // alone so the caller sees real content rather than NaN-shaped junk.
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return formatEpochAsMMDDYYYY(ms);
  return trimmed;
}

function formatEpochAsMMDDYYYY(ms: number): string {
  // UTC components — keeps the output timezone-independent. The faker
  // layer constructs dates as midnight UTC, so this stays consistent
  // end-to-end.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${mm}-${dd}-${yyyy}`;
}
