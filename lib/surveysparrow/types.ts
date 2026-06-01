// Types for the SurveySparrow REST API endpoints we use.
// Verified May 2026 against:
//   https://developers.surveysparrow.com/rest-apis/get-v-3-surveys/
//   https://developers.surveysparrow.com/rest-apis/get-v-3-questions/
//
// The official `properties` schema isn't fully enumerated in the docs and the
// real GET payload includes fields the docs don't list — most importantly
// `rtxt` (rich-text HTML) for the question text and `is_required` for the
// required flag. We treat the question shape loosely and normalize via
// `extractQuestionDisplay()` below so the UI is resilient to schema variations.

export interface Survey {
  id: number;
  name: string;
  archived: boolean;
  survey_type: string; // e.g. "ClassicForm", "Conversational", "NPS", "Kiosk"
  created_at: string;
  updated_at: string;
  survey_folder_id?: number | null;
  survey_folder_name?: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  has_next_page: boolean;
}

export type SurveyListResponse = PaginatedResponse<Survey>;

// A single answer choice. SS uses `text` per the POST schema and `txt` in
// some legacy response bodies; we accept both. `img` / `image` flag image
// choices (which Plumage skips because we generate text responses only).
export interface Choice {
  id?: number;
  text?: string;
  txt?: string;
  img?: string;
  image?: string;
  position?: string | number;
  question_id?: number;
  scale_point_id?: number | null;
}

export interface ScalePoint {
  id: number;
  name?: string;
  text?: string;
  position?: string | number;
}

// `properties` is intentionally permissive — SS surfaces a different subset
// per question type. `[key: string]: unknown` keeps strict mode happy while
// our extractor probes the fields it cares about.
export interface QuestionProperties {
  label?: string;
  text?: string;
  html_text?: string;
  rtxt?: string;
  description?: string;
  required?: boolean;
  // Some types nest config under `data` (opinion scale labels etc.)
  data?: Record<string, unknown>;
  choices?: Choice[];
  scale_points?: ScalePoint[];
  rating_scale?: number;
  scale?: number;
  min?: number;
  max?: number;
  [key: string]: unknown;
}

/**
 * Display / jump logic — conditional show-or-skip rules SS attaches to
 * a question. We mirror SS's wire shape verbatim so the evaluator can
 * walk the same fields the dashboard does.
 *
 * Example (display_logic — show this question only when choice 1007061174
 * was selected on question 1004040340):
 *   {
 *     "version": "1",
 *     "logics": [{
 *       "join_condition": "and",
 *       "type": "question",
 *       "comparator": "isSelected",
 *       "question_id": 1004040340,
 *       "choice_id": 1007061174,
 *       "value": ""
 *     }]
 *   }
 *
 * For `type: "variable"`, the condition is gated on a custom-variable's
 * value (the assistant's variable system). We probe `variable_name` /
 * `variable_id` tolerantly because SS surfaces this field under slightly
 * different names across workspaces.
 */
export type LogicJoinCondition = "and" | "or";

export type LogicComparator =
  | "isSelected"
  | "isNotSelected"
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual"
  | "contains"
  | "doesNotContain"
  | "startsWith"
  | "endsWith"
  | "isAnswered"
  | "isNotAnswered"
  | string; // unknown comparators fall through to "show by default" — safer than hiding by default

export interface LogicCondition {
  /** First entry's join_condition is ignored; subsequent entries combine
   *  via this against the running result. */
  join_condition?: LogicJoinCondition;
  /** "question" gates on another question's answer; "variable" gates on
   *  a custom-variable's value. */
  type?: "question" | "variable" | string;
  comparator: LogicComparator;
  /** Used when `type: "question"` — the upstream question being checked. */
  question_id?: number;
  /** Choice ID for isSelected / isNotSelected comparators. */
  choice_id?: number | null;
  /** String/number value for equals / contains / etc. */
  value?: string | number | null;
  /** Used when `type: "variable"` — different SS workspaces surface this
   *  under slightly different names; we probe all of them. */
  variable_name?: string;
  variable_id?: number | string;
}

export interface QuestionLogic {
  version?: string;
  /** Empty array (or undefined) = no logic — always show. */
  logics?: LogicCondition[];
}

export interface Question {
  id: number;
  type: string; // e.g. "MultiChoice", "OpinionScale", "TextInput", "NPS", "Rating"
  position: string;
  hasDisplayLogic?: boolean;
  properties?: QuestionProperties;
  survey_id: number;
  section_id?: number;
  account_id?: number;
  parent_question_id?: number | null;
  // Fields some workspaces expose at the top level:
  rtxt?: string;
  text?: string;
  html_text?: string;
  question_text?: string;
  title?: string;
  label?: string;
  is_required?: boolean;
  required?: boolean;
  // Top-level choices / scale points (SS often returns them here, not in properties)
  choices?: Choice[];
  scale_points?: ScalePoint[];
  // Synthetic rows populated by buildGroupedQuestions. SS returns child
  // questions (GroupRating_Statement, Matrix_Row, etc.) as siblings with
  // parent_question_id set — we fold them here so extractQuestionRows works.
  rows?: ExtractedRow[];
  // Conditional logic (phase: display-logic-respect). Both flags + objects
  // surface from the SS GET /v3/questions endpoint. The response builder
  // uses them to drop conditional-answer entries that wouldn't have been
  // shown to the persona, matching what a real respondent would experience.
  has_display_logic?: boolean;
  has_jump_logic?: boolean;
  display_logic?: QuestionLogic | null;
  jump_logic?: QuestionLogic | null;
  // Section the question belongs to. SS organises questions into ordered
  // sections; question.position is RESET within each section, so sorting
  // by question.position alone scrambles the survey order across
  // sections. Always sort by (section.position, question.position) — see
  // compareQuestionPositions below. Matrix child rows have section: null
  // because they're nested under their parent's section by reference.
  section?: { position?: string; title?: string | null } | null;
}

// ---------------------------------------------------------------------------
// Survey-order sort helpers
// ---------------------------------------------------------------------------
//
// HISTORICAL BUG, fixed here: prior to this helper, display-logic.ts,
// response-prompt.ts, and cascade-injector.ts each used a local
// parsePosition(q.position) and sorted by that scalar. SurveySparrow
// resets question.position within each section (section 1's last
// question can be position 6.0, section 2's first is position 1.0), so
// every consumer of that sort was walking the Fontainebleau survey in
// the wrong order. The display_logic walker would evaluate Q1004043885's
// gate BEFORE Q1004043884's answer was confirmed, mark it not-shown,
// and the validator post-filter would silently drop downstream answers.
// Always use compareQuestionPositions when ordering questions in
// survey-walk order.

/** Internal: turn an SS dotted-position string into a sortable number. */
function parsePositionString(p: string | undefined | null): number {
  if (!p) return 0;
  const parts = p.split(".").map((s) => Number.parseInt(s, 10));
  return parts.reduce(
    (acc, n, i) => acc + (Number.isNaN(n) ? 0 : n) / Math.pow(1000, i),
    0,
  );
}

/** Sort key for a question: [sectionPosition, questionPosition]. Sections
 *  without an explicit position sort to the front (matrix rows etc.). */
export function questionSortKey(q: Question): [number, number] {
  const sectionPos = parsePositionString(q.section?.position);
  const qPos = parsePositionString(q.position);
  return [sectionPos, qPos];
}

/** Comparator for Array.prototype.sort. Use everywhere we walk
 *  questions in survey order. */
export function compareQuestionPositions(a: Question, b: Question): number {
  const [as, aq] = questionSortKey(a);
  const [bs, bq] = questionSortKey(b);
  if (as !== bs) return as - bs;
  return aq - bq;
}

export type QuestionListResponse = PaginatedResponse<Question>;

export interface SurveySparrowError {
  message: string;
  code?: string | number;
  status: number;
}

// ---------------------------------------------------------------------------
// Display normalization
// ---------------------------------------------------------------------------

export interface QuestionDisplay {
  id: number;
  text: string;
  type: string;
  required: boolean;
  position: string;
  description?: string;
  choices?: Array<{ id?: number; text: string; hasImage: boolean }>;
  scalePoints?: Array<{ id: number; text: string }>;
  scale?: { min: number; max: number };
  /**
   * Matrix / GroupRating / ConstantSum row labels — populated from `q.rows`
   * (set by buildGroupedQuestions). Shown in the QuestionPreview accordion so
   * the user can see the statements being rated without digging into raw JSON.
   */
  rows?: Array<{ id: number; text: string }>;
  // True if every choice on this question is an image with no text — Plumage
  // can't generate text responses for these, so we filter them upstream.
  imageOnly: boolean;
  // True if this question type doesn't take choices or a scale (free text etc.)
  isFreeText: boolean;
}

const FALLBACK_TEXT = "(no question text)";

/**
 * Strip HTML tags / entities and collapse whitespace. SS returns rich-text
 * HTML for `rtxt`; we want a plain string for the UI.
 */
function stripHtml(input: string): string {
  if (!input) return "";
  // Decode common HTML entities and remove tags. We don't need a full parser —
  // SS rich text is shallow `<p>`, `<strong>`, `<em>`, `<br>` markup.
  const noTags = input.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string") {
      const cleaned = stripHtml(c);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return undefined;
}

function extractChoices(q: Question): QuestionDisplay["choices"] | undefined {
  // SS sometimes returns choices on the question, sometimes inside properties.
  const raw = (Array.isArray(q.choices) ? q.choices : q.properties?.choices) ?? null;
  if (!raw || raw.length === 0) return undefined;

  // SS Matrix questions store choices as scale-point proxies: each choice has
  // `txt: ""` and a `scale_point_id` linking to the real label in scale_points.
  // These proxies have no displayable text of their own and would show as
  // "Option 1006911891" etc. When the question also has scale_points (which
  // carry the real "Poor / Average / Good / Excellent" labels), suppress the
  // proxy choices entirely so the UI doesn't show a broken duplicate section.
  const hasScalePoints =
    (Array.isArray(q.scale_points) && q.scale_points.length > 0) ||
    (Array.isArray(q.properties?.scale_points) && (q.properties?.scale_points?.length ?? 0) > 0);
  if (hasScalePoints) {
    const allProxy = raw.every((c) => {
      const text = firstNonEmptyString(c.text, c.txt);
      return !text && c.scale_point_id != null;
    });
    if (allProxy) return undefined;
  }

  return raw.map((c) => {
    const text = firstNonEmptyString(c.text, c.txt) ?? "";
    const hasImage = Boolean(c.img || c.image);
    return {
      id: c.id,
      text: text || (hasImage ? "(image-only)" : `Option ${c.id ?? "?"}`),
      hasImage,
    };
  });
}

function extractScalePoints(q: Question): QuestionDisplay["scalePoints"] | undefined {
  const raw =
    (Array.isArray(q.scale_points) ? q.scale_points : q.properties?.scale_points) ?? null;
  if (!raw || raw.length === 0) return undefined;
  return raw.map((s) => ({
    id: s.id,
    text: firstNonEmptyString(s.name, s.text) ?? `Point ${s.id}`,
  }));
}

function extractScale(q: Question): QuestionDisplay["scale"] | undefined {
  const props = q.properties ?? {};
  if (typeof props.rating_scale === "number") {
    return { min: 1, max: props.rating_scale };
  }
  if (typeof props.scale === "number") {
    return { min: 1, max: props.scale };
  }
  if (typeof props.min === "number" && typeof props.max === "number") {
    return { min: props.min, max: props.max };
  }
  // OpinionScale / Slider: SS's `data.step` field IS the MAX value of the
  // scale, not an offset added to `start`. Buttons are start, start+1, …,
  // step. (Earlier this file claimed `start + step` was max — which over-
  // counted by `start` whenever start > 0. Verified May 2026 against
  // question 1004018813 where start=1, step=7 and the SS UI rendered
  // buttons 1-7; pushing rating=8 triggered SS's "Invalid value passed"
  // rejection because the scale max is 7, not 8.)
  // (`data.min` / `data.max` are template strings like "builder.opinion_scale.min"
  //  — never numbers — so we probe `start`/`step` first and only fall back
  //  to numeric `min`/`max` when both are genuine numbers that differ.)
  const data = props.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.start === "number" && typeof d.step === "number" && d.step > 0) {
      const min = d.start;
      const max = d.step;
      // Safety: if the data is somehow inverted (max <= min) fall through
      // to the wider numeric probes below rather than returning a
      // degenerate range.
      if (max > min) {
        return { min, max };
      }
    }
    if (typeof d.min === "number" && typeof d.max === "number" && d.min !== d.max) {
      return { min: d.min, max: d.max };
    }
    // GroupRating: star count stored under data.rating_scale.
    if (typeof d.rating_scale === "number") {
      return { min: 1, max: d.rating_scale };
    }
    if (typeof d.scale === "number") {
      return { min: 1, max: d.scale };
    }
  }
  // Sensible default for OpinionScale-ish types per SS's UX (1–5).
  if (q.type.toLowerCase().includes("nps")) return { min: 0, max: 10 };
  if (q.type.toLowerCase().includes("opinion") || q.type.toLowerCase().includes("rating")) {
    return { min: 1, max: 5 };
  }
  return undefined;
}

/**
 * Resolve the effective numeric scale for a question. Calls `extractScale`
 * and falls back to caller-supplied defaults when the SS API returns no
 * scale metadata — keeps per-type fallback logic in one place rather than
 * scattered across the prompt builder and validator.
 */
export function resolveScale(
  q: Question,
  defaultMin: number,
  defaultMax: number,
): { min: number; max: number } {
  return extractScale(q) ?? { min: defaultMin, max: defaultMax };
}

const FREE_TEXT_TYPES = [
  "textinput",
  "text_input",
  "text",
  "comment",
  "longtext",
  "shorttext",
  "email",
  "phone",
  "number",
  "url",
  "date",
  "datetime",
  "consent",
  "address",
  "contactform",
  "fileupload",
];

function isFreeTextType(type: string): boolean {
  const lower = type.toLowerCase().replace(/[\s_-]/g, "");
  return FREE_TEXT_TYPES.some((t) => lower.includes(t));
}

export function extractQuestionDisplay(q: Question): QuestionDisplay {
  const props = q.properties ?? {};

  const text =
    firstNonEmptyString(
      // `rtxt` is the rich-text HTML field SS actually returns (per community docs).
      q.rtxt,
      props.rtxt,
      // POST schema documents `text` as the canonical field; mirror that on GET.
      q.text,
      q.html_text,
      props.text,
      props.html_text,
      props.label,
      // Long-tail aliases observed in the wild / used by SS internals.
      q.title,
      q.label,
      q.question_text,
    ) ?? FALLBACK_TEXT;

  const required =
    (typeof q.is_required === "boolean" && q.is_required) ||
    (typeof q.required === "boolean" && q.required) ||
    (typeof props.required === "boolean" && props.required) ||
    false;

  const choices = extractChoices(q);
  const scalePoints = extractScalePoints(q);
  const scale = extractScale(q);

  // Matrix row labels — populated by buildGroupedQuestions into q.rows.
  // Only include when the question actually has rows (non-empty array of
  // ExtractedRow objects with a numeric id and string label).
  const displayRows: QuestionDisplay["rows"] =
    Array.isArray(q.rows) && q.rows.length > 0
      ? q.rows.map((r) => ({ id: r.id, text: r.label }))
      : undefined;

  const imageOnly =
    Boolean(choices) &&
    choices!.length > 0 &&
    choices!.every((c) => c.hasImage && c.text === "(image-only)");

  return {
    id: q.id,
    text,
    type: q.type,
    required,
    position: q.position,
    description: firstNonEmptyString(props.description),
    choices,
    scalePoints,
    scale,
    rows: displayRows,
    imageOnly,
    isFreeText: isFreeTextType(q.type) && !choices && !scalePoints,
  };
}

// ---------------------------------------------------------------------------
// Row / column extraction for matrix-style questions
// ---------------------------------------------------------------------------
//
// Matrix, BipolarMatrix, GroupRating, ConstantSum, ContactForm — all carry
// per-row sub-questions. SS isn't consistent about WHERE the row data lives
// in the GET response: workspaces have been observed surfacing it at
// `q.row`, `q.properties.row`, and `q.properties.data.row`. Same story for
// columns (`q.column`, `q.properties.column`). This helper probes every
// known location and returns a normalized list with positional fallback IDs.
//
// The first observed shipping bug (Phase 5a, 2026-05): GroupRating rows
// were missing in the GET response at the path my prompt + validator
// probed, leading to silent empty-row answers. Fix is to be permissive at
// extraction time and to fail loudly downstream when truly nothing is
// found.

export interface ExtractedRow {
  id: number;
  label: string;
}

/**
 * Pull row/statement entries off a Question, regardless of where SS chose to
 * put them. Returns an empty array only if no candidate location yields any
 * rows — callers should treat that as a question-shape error.
 */
export function extractQuestionRows(q: Question): ExtractedRow[] {
  const candidates = collectRowCandidates(q);
  for (const raw of candidates) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    return raw.map((r, i) => normalizeRow(r, i));
  }
  return [];
}

/**
 * Pull column/scale-point entries off a Question. Matrix questions store
 * columns under `q.column` (matching the POST shape), but some workspaces
 * surface them under `q.properties.column` or as `scale_points` instead.
 *
 * SPECIAL CASE — Matrix LIKERT (verified via Postman 2026-06-01):
 * When a Matrix question carries BOTH `choices` AND `scale_points`, with
 * choices linked to scale_points via `scale_point_id` (the canonical SS
 * Likert shape), the answer SS actually accepts on /v3/responses/batch
 * is the CHOICE id (`1007067xxx`-shaped), NOT the scale_point id
 * (`1000505xxx`-shaped). The SS docs describe Matrix SINGLE_ANSWER as
 * taking a scale-point ID — but their /v3/responses/batch endpoint
 * rejects scale_point IDs with the misleading "Invalid value passed or
 * missing values in payload" error. Choices with their labels inherited
 * from the linked scale_points succeed. We return choices here so the
 * prompt + builder send choice_ids end-to-end.
 */
export function extractQuestionColumns(q: Question): ExtractedRow[] {
  // Matrix LIKERT short-circuit: choices linked to scale_points.
  const likertColumns = extractMatrixLikertColumns(q);
  if (likertColumns) return likertColumns;

  const dataProps = (q.properties?.data as Record<string, unknown> | undefined) ?? {};
  const candidates: unknown[] = [
    (q as unknown as { column?: unknown }).column,
    q.properties?.column,
    dataProps.column,
    // scale_points at multiple depths — Matrix uses these as the column axis.
    Array.isArray(q.scale_points) ? q.scale_points : null,
    Array.isArray(q.properties?.scale_points) ? q.properties.scale_points : null,
    // SS sometimes nests scale_points under properties.data
    Array.isArray(dataProps.scale_points) ? dataProps.scale_points : null,
    // columns field (synthetic, populated by buildGroupedQuestions for
    // matrix questions that represent columns as sibling child questions)
    (q as unknown as { columns?: unknown }).columns,
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    return raw.map((c, i) => normalizeRow(c, i));
  }
  return [];
}

/**
 * Detect the Matrix LIKERT shape and return the column set the SS
 * /v3/responses/batch endpoint will accept (choice IDs, with labels
 * from the linked scale_points). Returns null when the question does
 * not match the Matrix LIKERT pattern — caller falls back to the
 * generic column probes.
 *
 * Trigger conditions:
 *   • Question has a non-empty `choices` array, AND
 *   • Question has a non-empty `scale_points` array, AND
 *   • Every choice has a numeric `scale_point_id` referencing one of
 *     the scale_points.
 *
 * The label preference order is: linked scale_point's `name`, then its
 * `text`, then the choice's own `text`/`txt` (usually empty for Likert),
 * with a positional fallback. This gives the LLM readable column labels
 * (e.g. "0", "1", ..., "10", "N/A") even though the IDs it must emit
 * are the long choice_ids.
 */
function extractMatrixLikertColumns(q: Question): ExtractedRow[] | null {
  const choices = Array.isArray(q.choices)
    ? q.choices
    : Array.isArray(q.properties?.choices)
      ? q.properties.choices
      : null;
  const scalePoints = Array.isArray(q.scale_points)
    ? q.scale_points
    : Array.isArray(q.properties?.scale_points)
      ? q.properties.scale_points
      : null;
  if (!choices || choices.length === 0) return null;
  if (!scalePoints || scalePoints.length === 0) return null;

  const everyChoiceLinked = choices.every(
    (c) => typeof c.scale_point_id === "number",
  );
  if (!everyChoiceLinked) return null;

  const scalePointById = new Map<number, ScalePoint>();
  for (const sp of scalePoints) {
    if (typeof sp.id === "number") scalePointById.set(sp.id, sp);
  }

  return choices.map((c, i): ExtractedRow => {
    const sp =
      typeof c.scale_point_id === "number"
        ? scalePointById.get(c.scale_point_id)
        : undefined;
    const label =
      firstNonEmptyString(sp?.name, sp?.text, c.text, c.txt) ??
      `Option ${i + 1}`;
    const id = typeof c.id === "number" ? c.id : i + 1;
    return { id, label };
  });
}

function collectRowCandidates(q: Question): unknown[] {
  const props = q.properties ?? {};
  const data = (props.data as Record<string, unknown> | undefined) ?? {};
  return [
    q.rows,                                      // from buildGroupedQuestions
    (q as unknown as { row?: unknown }).row,
    (props as Record<string, unknown>).row,
    (props as Record<string, unknown>).rows,
    data.row,
    data.rows,
  ];
}

function normalizeRow(raw: unknown, index: number): ExtractedRow {
  if (!raw || typeof raw !== "object") {
    return { id: index + 1, label: `Row ${index + 1}` };
  }
  const o = raw as Record<string, unknown>;
  const id =
    typeof o.id === "number" ? o.id
    : typeof o.id === "string" && /^\d+$/.test(o.id) ? Number.parseInt(o.id, 10)
    : index + 1;
  const label =
    firstNonEmptyString(o.left_text, o.text, o.name, o.label) ?? `Row ${index + 1}`;
  return { id, label };
}

/**
 * SS returns matrix-style question families as a flat list. The parent
 * question (GroupRating, Matrix, BipolarMatrix, ConstantSum, etc.) has
 * `parent_question_id: null`; each row/statement is a sibling with
 * `parent_question_id` pointing at the parent. E.g.:
 *
 *   GroupRating          id=1003951813  parent=null
 *   GroupRating_Statement id=1003951814  parent=1003951813
 *   GroupRating_Statement id=1003951815  parent=1003951813
 *   ...
 *
 * For Matrix / BipolarMatrix questions, SS may also represent column options
 * as sibling child questions with type containing "col" (e.g. "Matrix_Column",
 * "MatrixCol", "BipolarColumn"). We separate these from row-type children:
 *   - Row-type children  → `q.rows`   (used by extractQuestionRows)
 *   - Column-type children → `q.columns` (undeclared field; picked up by
 *     extractQuestionColumns as the FIRST candidate so the prompt and CSV
 *     serializer both see the right column labels and IDs)
 *
 * Removes all child questions from the top-level list.
 */
/**
 * Some child question types are NOT structural rows of their parent — they
 * are SEPARATELY-ANSWERABLE follow-up questions keyed off the parent's score.
 * The canonical example is `NPSFeedback`: it's a child of `NPSScore` (so it
 * carries `parent_question_id`) but it is its own answerable question that
 * needs its own answer entry in the push payload, WITH `parent_question_id`
 * set so SS associates the text with the right branch (promoter / passive /
 * detractor) of the parent's score.
 *
 * Folding these as `rows` of the parent would silently drop them from the
 * LLM prompt and from the push payload — producing the "Not Answered"
 * symptom we saw on the NPS follow-up. Instead we keep them at the top
 * level WITH `parent_question_id` preserved, so the push builder can
 * include it on the answer entry.
 */
function isFollowUpChildType(type: string): boolean {
  const normalized = type.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Conservative: only types whose name ends in "feedback" are treated as
  // follow-ups. Covers NPSFeedback today; same shape would cover any
  // future *Feedback type (CSATFeedback, OpinionScaleFeedback) without
  // a code change here.
  return normalized.endsWith("feedback");
}

export function buildGroupedQuestions(questions: Question[]): Question[] {
  const childrenByParent = new Map<number, Question[]>();
  for (const q of questions) {
    if (q.parent_question_id != null && !isFollowUpChildType(q.type)) {
      // Genuine row-style children only — these get folded into the
      // parent's `rows` array. Follow-up types (NPSFeedback etc.) are
      // skipped here so they stay at the top level below.
      const arr = childrenByParent.get(q.parent_question_id) ?? [];
      arr.push(q);
      childrenByParent.set(q.parent_question_id, arr);
    }
  }

  if (childrenByParent.size === 0) {
    // No row-children to fold — but we still need to keep follow-up
    // children in the result. They survive the no-folding fast-path
    // naturally because `questions` is returned as-is.
    return questions;
  }

  return questions
    // Keep top-level questions PLUS follow-up children (NPSFeedback etc.):
    // the latter need to be answered separately by the LLM and pushed with
    // `parent_question_id` set on the answer entry.
    .filter((q) => q.parent_question_id == null || isFollowUpChildType(q.type))
    .map((q) => {
      const children = childrenByParent.get(q.id);
      if (!children || children.length === 0) return q;

      const sorted = [...children].sort(
        (a, b) => parseFloat(a.position) - parseFloat(b.position),
      );

      // Separate column-type children (type contains "col", case-insensitive,
      // stripped of non-alphanumeric chars) from row-type children.
      const colNeedle = "col";
      const rowChildren: Question[] = [];
      const colChildren: Question[] = [];
      for (const child of sorted) {
        const normalized = child.type.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normalized.includes(colNeedle)) {
          colChildren.push(child);
        } else {
          rowChildren.push(child);
        }
      }

      // When ALL children fall into one bucket (no "col" type detected), treat
      // them all as row children — this is the normal case for GroupRating,
      // ConstantSum, and Matrix variants where columns live in parent fields.
      const effectiveRowChildren = colChildren.length > 0 ? rowChildren : sorted;

      const toExtractedRow = (child: Question, i: number): ExtractedRow => {
        const label =
          firstNonEmptyString(
            child.rtxt,
            child.text,
            child.html_text,
            child.question_text,
            child.title,
            child.label,
          ) ?? `Row ${i + 1}`;
        return { id: child.id, label };
      };

      const rows: ExtractedRow[] = effectiveRowChildren.map(toExtractedRow);

      if (colChildren.length === 0) {
        return { ...q, rows };
      }

      // Store column children in an undeclared `columns` field so
      // extractQuestionColumns can find them (it checks `q.columns` first).
      const columns: ExtractedRow[] = colChildren.map(toExtractedRow);
      return { ...q, rows, columns } as Question & { columns: ExtractedRow[] };
    });
}

/**
 * Drop questions that Plumage can't generate text responses for (image-only
 * choices). Returns the kept questions and the count of skipped ones so the
 * UI can show a hint.
 */
export function partitionQuestionsForGeneration(qs: Question[]): {
  kept: Question[];
  skippedImageOnly: number;
} {
  let skipped = 0;
  const kept = qs.filter((q) => {
    const d = extractQuestionDisplay(q);
    if (d.imageOnly) {
      skipped += 1;
      return false;
    }
    return true;
  });
  return { kept, skippedImageOnly: skipped };
}

export { FALLBACK_TEXT };
