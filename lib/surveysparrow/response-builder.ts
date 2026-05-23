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
  for (const [qidStr, answer] of Object.entries(response.answers)) {
    const qid = parseInt(qidStr, 10);
    if (!Number.isFinite(qid)) continue;
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

      // Defensive: clamp numeric answers to the question's actual scale.
      // SS rejects any value outside the configured min/max with a
      // generic "Invalid value passed or missing values in payload"
      // error. The validator already enforces this at generation time,
      // but its resolved scale may be wider than SS's actual config
      // (e.g. when the question type is "OpinionScale" but the SS
      // workspace has it configured 0-7 rather than 0-10). Clamping here
      // is the last-mile guarantee that the payload stays within range.
      if (
        scalesMap &&
        typeof entry.answer === "number" &&
        !Array.isArray(entry.answer)
      ) {
        const scale = scalesMap.get(qid);
        if (scale) {
          if (entry.answer < scale.min) entry.answer = scale.min;
          else if (entry.answer > scale.max) entry.answer = scale.max;
        }
      }

      answers.push(entry);
    }
  }

  // date_time in meta_data = survey start (submit minus random 2–10 min).
  const submitMs = new Date(persona.submittedAt).getTime();
  const startMs = submitMs - (2 + Math.random() * 8) * 60_000;

  const channelId =
    options?.channels && options.channels.length > 0
      ? pickChannel(options.channels)
      : undefined;

  const tagsForResponse: string[] = options?.tags ?? [];

  return {
    contact: {
      full_name: persona.name,
      ...(persona.email ? { email: persona.email } : {}),
      ...(persona.phone ? { phone: persona.phone } : {}),
      contact_type: "contact",
    },
    trigger_workflow: options?.triggerWorkflow ?? false,
    ...(channelId !== undefined ? { channel_id: channelId } : {}),
    ...(Object.keys(persona.variableValues).length > 0
      ? { variables: persona.variableValues }
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
        answer: answer.value,
        region_code: persona.country || undefined,
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
