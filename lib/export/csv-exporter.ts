// Pure CSV-building functions for the SS Response Migration marketplace app.
// No React imports — safe to call from any client component.
//
// Entry point: buildCsvRows(responses, personas, survey, questions, draft)
//   → { headers: string[], rows: string[][] }
//
// Then: Papa.unparse({ fields: headers, data: rows }) → CSV string.
//
// ─── Documented ambiguity resolutions ───────────────────────────────────────
//
// 1. Column ordering: metadata → contact → variables → questions.
//    Rationale in csv-types.ts.
//
// 2. Variable column naming: apiIdentifier directly (no prefix).
//    Matches the key the SS API uses for variables.
//
// 3. Matrix column headers: "{QuestionText} - {RowLabel}" (truncated to 200).
//    Chosen to be human-readable and unambiguous. SS importer maps by column
//    position, not header text, so the exact format doesn't affect import
//    correctness — but readable headers help with pre-import review.
//
// 4. "Language" metadata column value: full display name ("English", "French").
//    Doc says "Any string, ex - English" — we output the English display name.
//
// 5. "Browser Language" column value: BCP 47 locale tag (e.g. "en-US").
//    Combines persona.language (ISO 639-1) + persona.country (ISO 3166-1 α-2).
//
// 6. Tags encoding: JSON array literal ["Tag1","Tag2"] as the cell value.
//    Doc example: ["Tag1", "Tag2"] — we omit the space for clean JSON.
//
// 7. Skipped questions: screen / file / voice / video / contact buckets.
//    Contact-bucket questions (email, phone, contactform) are represented
//    by the dedicated Contact columns instead.
//
// 8. Empty cells: empty string "". Never "null", "N/A", or "-".
//
// 9. Date variables (stored as YYYY-MM-DD by faker-layer): reformatted to
//    MM-DD-YYYY per SS importer requirement for custom variable dates.
//
// 10. DateOnly question answers (stored as ISO 8601): reformatted per the
//     question's configured date_format (probed from q.properties.date_format),
//     defaulting to YYYY/MM/DD if unset.
//
// 11. Device type mapping: Desktop → "COMPUTER", Mobile → "MOBILE",
//     Tablet → "TABLET". Doc example uses "COMPUTER" for desktop.

import type { GeneratedResponse, AnswerValue } from "@/lib/generation/response-types";
import type { Persona } from "@/lib/generation/persona-types";
import type { Survey, Question } from "@/lib/surveysparrow/types";
import type { ProfileDraft, CustomVariable } from "@/lib/profiles/types";
import {
  extractQuestionDisplay,
  extractQuestionRows,
  extractQuestionColumns,
  buildGroupedQuestions,
} from "@/lib/surveysparrow/types";
import { getQuestionTypeMeta } from "@/lib/surveysparrow/question-types";
import {
  MAX_CSV_ROWS,
  MAX_HEADER_LENGTH,
  LANGUAGE_DISPLAY_NAMES,
  SYSTEM_COL_HEADERS,
  CONTACT_COL_HEADERS,
  SKIPPED_BUCKETS,
  MULTI_COL_CANONICALS,
  type QuestionColumn,
} from "./csv-types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CsvBuildResult {
  headers: string[];
  rows: string[][];
}

export interface CsvValidationWarning {
  kind: "row_limit" | "unsupported_type" | "incomplete_responses";
  message: string;
}

/**
 * Build CSV headers + data rows from a complete set of generated responses.
 *
 * @param responses  Generated responses from the responses store.
 * @param personas   Corresponding personas (must include every personaId referenced).
 * @param survey     The selected survey (used only for metadata; not structure).
 * @param rawQuestions  Raw question list from the survey store.
 *                      buildGroupedQuestions is called internally to fold
 *                      matrix/group-rating rows into their parents.
 * @param draft      Generation configuration draft (variables, metadata config).
 */
export function buildCsvRows(
  responses: GeneratedResponse[],
  personas: Persona[],
  survey: Survey,
  rawQuestions: Question[],
  draft: ProfileDraft,
): CsvBuildResult {
  const personasById = new Map(personas.map((p) => [p.id, p] as const));

  // Fold child rows (GroupRating_Statement, Matrix rows, etc.) into parents.
  const questions = buildGroupedQuestions(rawQuestions);

  // Build question column descriptors (skip non-answerable structural types).
  const questionCols = buildQuestionColumns(questions);

  // Assemble final header row.
  const headers: string[] = [
    ...SYSTEM_COL_HEADERS,
    ...CONTACT_COL_HEADERS,
    ...draft.customVariables.map((v) => v.apiIdentifier),
    ...questionCols.map((c) => c.header),
  ];

  // Build one data row per response.
  const rows = responses.map((response) => {
    const persona = personasById.get(response.personaId);
    if (!persona) return headers.map(() => ""); // safety: shouldn't happen
    return buildResponseRow(response, persona, draft, questionCols);
  });

  void survey; // included in signature for symmetry; not needed for cell values

  return { headers, rows };
}

/**
 * Run pre-export validation and return any warnings. Warnings are advisory —
 * the user can still download. A `row_limit` warning should block download.
 */
export function validateForCsvExport(
  responses: GeneratedResponse[],
  rawQuestions: Question[],
): CsvValidationWarning[] {
  const warnings: CsvValidationWarning[] = [];

  // Hard limit: SS importer accepts ≤ 5,000 rows.
  if (responses.length > MAX_CSV_ROWS) {
    warnings.push({
      kind: "row_limit",
      message: `Response count (${responses.length.toLocaleString()}) exceeds the 5,000-row limit — split into batches before importing.`,
    });
  }

  // Image-only questions can't produce text labels for their choices.
  const imageOnlyLabels: string[] = [];
  for (const q of rawQuestions) {
    const d = extractQuestionDisplay(q);
    if (d.imageOnly) {
      imageOnlyLabels.push(d.text.length > 60 ? d.text.slice(0, 57) + "…" : d.text);
    }
  }
  if (imageOnlyLabels.length > 0) {
    warnings.push({
      kind: "unsupported_type",
      message:
        `${imageOnlyLabels.length} question(s) have image-only choices ` +
        `and will produce empty cells: ${imageOnlyLabels.slice(0, 3).join(", ")}` +
        (imageOnlyLabels.length > 3 ? ` (+${imageOnlyLabels.length - 3} more)` : ""),
    });
  }

  // Responses with no answers at all (e.g. failed generation that was accepted).
  const empty = responses.filter((r) => Object.keys(r.answers).length === 0).length;
  if (empty > 0) {
    warnings.push({
      kind: "incomplete_responses",
      message: `${empty} response(s) have no answers and will produce blank rows.`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Column construction
// ---------------------------------------------------------------------------

export function buildQuestionColumns(questions: Question[]): QuestionColumn[] {
  const cols: QuestionColumn[] = [];

  for (const q of questions) {
    const meta = getQuestionTypeMeta(q.type);
    if (SKIPPED_BUCKETS.has(meta.bucket)) continue;

    const questionText = extractQuestionDisplay(q).text;

    if (MULTI_COL_CANONICALS.has(meta.canonical)) {
      const rows = extractQuestionRows(q);
      if (rows.length > 0) {
        for (const row of rows) {
          cols.push({
            header: truncateHeader(`${questionText} - ${row.label}`),
            questionId: q.id,
            question: q,
            rowId: String(row.id),
          });
        }
      } else {
        // Rows not available (unexpected schema): fall back to a single column.
        cols.push({ header: truncateHeader(questionText), questionId: q.id, question: q });
      }
    } else {
      cols.push({ header: truncateHeader(questionText), questionId: q.id, question: q });
    }
  }

  return cols;
}

/** Returns the column headers for a matrix question's row expansion. */
export function expandMatrixColumns(question: Question): string[] {
  const qText = extractQuestionDisplay(question).text;
  return extractQuestionRows(question).map((r) =>
    truncateHeader(`${qText} - ${r.label}`),
  );
}

/** Returns the column headers for a ConstantSum question's option expansion. */
export function expandConstantSumColumns(question: Question): string[] {
  const qText = extractQuestionDisplay(question).text;
  return extractQuestionRows(question).map((r) =>
    truncateHeader(`${qText} - ${r.label}`),
  );
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

function buildResponseRow(
  response: GeneratedResponse,
  persona: Persona,
  draft: ProfileDraft,
  questionCols: QuestionColumn[],
): string[] {
  const row: string[] = [];

  // ── 1. System metadata ────────────────────────────────────────────────────
  // "Created At" — ISO 8601 UTC. persona.submittedAt is already in this format.
  row.push(persona.submittedAt);

  // Browser, OS, Device Type — always from persona (faker generated them).
  row.push(persona.browser);
  row.push(persona.os);
  row.push(mapDeviceTypeForCsv(persona.deviceType));

  // Time Zone — IANA string (e.g. "America/New_York").
  row.push(persona.timezone);

  // IP Address — null when ip mode is "none".
  row.push(persona.ipAddress ?? "");

  // Browser Language — BCP 47 locale tag: "<lang>-<COUNTRY>" (e.g. "en-US").
  row.push(`${persona.language}-${persona.country}`);

  // Language — human-readable display name (doc: "ex - English").
  row.push(mapLanguageCodeToName(persona.language));

  // Tags — JSON array literal (doc: ["Tag1", "Tag2"]).
  const tags = draft.systemMetadata.tags.enabled
    ? draft.systemMetadata.tags.values
    : [];
  row.push(formatTagsForCsv(tags));

  // ── 2. Contact ────────────────────────────────────────────────────────────
  row.push(persona.name);
  row.push(persona.email);
  row.push(persona.phone);

  // ── 3. Custom variables ───────────────────────────────────────────────────
  for (const variable of draft.customVariables) {
    row.push(serializeVariableValue(variable, persona));
  }

  // ── 4. Question answers ───────────────────────────────────────────────────
  // Use serializeAnswerWithQuestion (not serializeAnswerForCsv) so that
  // matrix scale-point IDs and ranking choice IDs are resolved to their
  // display labels ("Poor" / "Excellent" / "Option A") rather than raw numbers.
  for (const col of questionCols) {
    const answer = response.answers[String(col.questionId)];
    row.push(answer ? serializeAnswerWithQuestion(answer, col.question, col.rowId) : "");
  }

  return row;
}

// ---------------------------------------------------------------------------
// Answer serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single AnswerValue cell for CSV output.
 *
 * @param answer  The AnswerValue from response.answers[questionId].
 * @param rowId   For multi-column types: the row id to look up in answer.rows.
 *                Undefined for single-value columns.
 *
 * NOTE: Matrix scale-point / choice labels are encoded on the AnswerValue by the
 * LLM validator (single_choice.choiceLabel, multi_choice.choices[].label). For
 * matrix types the rows only carry IDs — we resolve those via the question
 * object stored on the column. To keep this function signature simple and pure,
 * matrix label lookup is delegated to helpers that receive the question lazily
 * via the QuestionColumn descriptor set up by buildQuestionColumns.
 *
 * In practice, matrix_single / matrix_multiple / matrix_dropdown all store IDs
 * in rows. We call this function from buildResponseRow which already has the
 * full Question object via questionCols. So the caller passes it through
 * rowId (not question) — the question itself is accessed via the column
 * descriptor stored in the closure built by buildQuestionColumns.
 *
 * For the exported `serializeAnswerForCsv` used by callers outside the module,
 * we expose the simpler (answer, rowId) form since question metadata is not
 * needed for the non-matrix types.
 */
export function serializeAnswerForCsv(answer: AnswerValue, rowId?: string): string {
  switch (answer.type) {
    // ── Free-text / scalar ──
    case "text":
    case "url":
    case "email":
    case "phone":
      return answer.value;

    case "number":
      return String(answer.value);

    case "date":
      // Date format is not available in this signature; use YYYY/MM/DD default.
      // Callers that know the question can call formatDateForCsv directly.
      return formatDateForCsv(answer.value, "YYYY/MM/DD");

    // ── Numeric scales ──
    case "nps":
    case "csat":
    case "ces":
    case "rating":
    case "opinion_scale":
    case "slider":
      return String(answer.value);

    // ── Boolean ──
    case "yes_no":
      // Doc: "Yes" or "No" (case-sensitive)
      return answer.value ? "Yes" : "No";

    // ── Choice questions — labels stored on the answer ──
    case "single_choice":
      return answer.choiceLabel;

    case "dropdown":
      return answer.choiceLabel;

    case "multi_choice":
      // Doc: "choice1,choice2" — comma-separated, no spaces around commas.
      return answer.choices.map((c) => c.label).join(",");

    case "ranking":
      // Doc: "order2,order1,order3" — comma-separated in ranked order.
      // orderedChoiceIds hold the chosen order; we fall back to ID strings
      // when label lookup isn't available in this call path.
      return answer.orderedChoiceIds.join(",");

    // ── Matrix: single answer per row → one column per row ──
    case "matrix_single": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      return val !== undefined ? String(val) : "";
    }

    case "matrix_multiple": {
      if (!rowId) return "";
      const vals = answer.rows[rowId];
      return Array.isArray(vals) ? vals.join(",") : "";
    }

    case "matrix_dropdown": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      return val !== undefined ? String(val) : "";
    }

    case "matrix_text": {
      if (!rowId) return "";
      const cells = answer.rows[rowId];
      if (!cells || cells.length === 0) return "";
      return cells.map((c) => c.text).join(", ");
    }

    case "matrix_rating": {
      if (!rowId) return "";
      const cells = answer.rows[rowId];
      if (!cells || cells.length === 0) return "";
      return String(cells[0]?.value ?? "");
    }

    // ── Sub-question per-row types ──
    case "group_rating": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      return val !== undefined ? String(val) : "";
    }

    case "constant_sum": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      return val !== undefined ? String(val) : "";
    }

    default:
      return "";
  }
}

/**
 * Full-fidelity answer serializer used inside buildResponseRow, where the
 * Question is available for label lookup. Handles matrix types with proper
 * scale-point / choice label resolution.
 */
export function serializeAnswerWithQuestion(
  answer: AnswerValue,
  question: Question,
  rowId?: string,
): string {
  // For types that need label lookup, resolve here.
  switch (answer.type) {
    case "ranking": {
      const choiceMap = buildChoiceMap(question);
      return answer.orderedChoiceIds
        .map((id) => choiceMap.get(id) ?? String(id))
        .join(",");
    }

    case "matrix_single": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      if (val === undefined) return "";
      const spMap = buildScalePointMap(question);
      return spMap.get(val) ?? String(val);
    }

    case "matrix_multiple": {
      if (!rowId) return "";
      const vals = answer.rows[rowId];
      if (!Array.isArray(vals) || vals.length === 0) return "";
      const spMap = buildScalePointMap(question);
      return vals.map((id) => spMap.get(id) ?? String(id)).join(",");
    }

    case "matrix_dropdown": {
      if (!rowId) return "";
      const val = answer.rows[rowId];
      if (val === undefined) return "";
      const choiceMap = buildChoiceMap(question);
      return choiceMap.get(val) ?? String(val);
    }

    case "date": {
      // Use the question's configured date_format if available.
      const rawFmt = question.properties?.["date_format"];
      const fmt = typeof rawFmt === "string" ? rawFmt : "YYYY/MM/DD";
      return formatDateForCsv(answer.value, fmt);
    }

    default:
      return serializeAnswerForCsv(answer, rowId);
  }
}

// ---------------------------------------------------------------------------
// Variable serialization
// ---------------------------------------------------------------------------

function serializeVariableValue(variable: CustomVariable, persona: Persona): string {
  const val = persona.variableValues[variable.apiIdentifier];
  if (val === undefined || val === null) return "";

  if (variable.type === "DATE" && typeof val === "string") {
    // faker-layer stores DATE vars as YYYY-MM-DD; SS importer expects MM-DD-YYYY.
    return formatDateVarForCsv(val);
  }

  return String(val);
}

// ---------------------------------------------------------------------------
// Label-lookup helpers (built from the Question object)
// ---------------------------------------------------------------------------

/**
 * Build a map of scale-point id → label from a question's column definitions.
 * Used for matrix_single and matrix_multiple answer types.
 *
 * SS Matrix questions surface their column options (scale points) in one of
 * two ways depending on workspace / question type:
 *
 *   A) Embedded in the parent question as `q.column`, `q.scale_points`, etc.
 *      → `extractQuestionColumns` finds these and returns them directly.
 *
 *   B) Represented as sibling child questions (type "Matrix_Column" or
 *      similar) with `parent_question_id` pointing at the matrix parent.
 *      `buildGroupedQuestions` folds ALL children into `q.rows`, mixing row-
 *      type and column-type children together. In this shape, none of the
 *      standalone column-data fields (`q.column`, `q.scale_points`, …) are
 *      populated, so `extractQuestionColumns` returns [].
 *
 * When case B is detected (extractQuestionColumns returns []), we build the
 * map from every entry in `q.rows`. The answer's scale-point values are the
 * child question IDs that the LLM chose, and those IDs are present in q.rows
 * alongside (but indistinguishable from) the row children. Mapping ALL
 * children id→label is safe: we look up only the value the LLM stored,
 * which will be a column-child ID if the LLM followed the prompt correctly.
 */
function buildScalePointMap(question: Question): Map<number, string> {
  const map = new Map<number, string>();

  // Primary: dedicated column fields (case A).
  const cols = extractQuestionColumns(question);
  if (cols.length > 0) {
    for (const col of cols) {
      map.set(col.id, col.label);
    }
    return map;
  }

  // Fallback: q.rows contains all child questions (rows + columns mixed).
  // For case B, the scale-point IDs the LLM used are column-child IDs stored
  // in q.rows — index all of them so spMap.get(scalePointId) resolves.
  if (Array.isArray(question.rows) && question.rows.length > 0) {
    for (const row of question.rows) {
      map.set(row.id, row.label);
    }
  }

  return map;
}

/**
 * Build a map of choice id → label from a question's choices array.
 * Used for matrix_dropdown and ranking answer types.
 */
function buildChoiceMap(question: Question): Map<number, string> {
  const map = new Map<number, string>();
  const raw =
    (Array.isArray(question.choices) ? question.choices : question.properties?.choices) ?? [];
  for (const c of raw) {
    if (c.id != null) {
      const label = c.text ?? c.txt ?? `Option ${c.id}`;
      map.set(c.id, label);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Formatting helpers (exported per spec)
// ---------------------------------------------------------------------------

/**
 * Format a tags array as the SS importer expects: JSON array literal.
 * Doc example: ["Tag1", "Tag2"]
 */
export function formatTagsForCsv(tags: string[]): string {
  if (tags.length === 0) return "";
  return JSON.stringify(tags); // → '["Tag1","Tag2"]'
}

/**
 * Reformat an ISO 8601 date string to the format configured on the question.
 *
 * @param isoDate  ISO date string (e.g. "2024-03-30" or "2024-03-30T10:15:30.000Z")
 * @param format   "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY/MM/DD"
 */
export function formatDateForCsv(
  isoDate: string,
  format: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY/MM/DD" | string,
): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate; // unparseable — pass through
  const year = d.getUTCFullYear().toString();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (format === "DD/MM/YYYY") return `${day}/${month}/${year}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
  return `${year}/${month}/${day}`; // YYYY/MM/DD — default
}

/**
 * Reformat a DATE custom variable value from faker-layer's storage format
 * (YYYY-MM-DD) to the SS importer's required format (MM-DD-YYYY).
 */
function formatDateVarForCsv(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const [, year, month, day] = m;
  return `${month}-${day}-${year}`;
}

/**
 * Map a language ISO 639-1 code to its English display name.
 * Falls back to the raw code if the code isn't in the registry.
 */
export function mapLanguageCodeToName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code;
}

/**
 * Map Plumage's DeviceType to the format SS uses in its importer.
 * Doc example shows "COMPUTER" for desktop devices.
 */
export function mapDeviceTypeForCsv(device: string): string {
  switch (device) {
    case "Desktop": return "COMPUTER";
    case "Mobile":  return "MOBILE";
    case "Tablet":  return "TABLET";
    default:        return device.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function truncateHeader(text: string): string {
  if (text.length <= MAX_HEADER_LENGTH) return text;
  return text.slice(0, MAX_HEADER_LENGTH - 1) + "…";
}

// ---------------------------------------------------------------------------
// Filename helper (exported for use in the component)
// ---------------------------------------------------------------------------

/**
 * Generate a download filename:
 *   plumage-{survey-name-slugified}-{YYYY-MM-DD-HHmm}.csv
 */
export function buildCsvFilename(surveyName: string): string {
  const slug = surveyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `plumage-${slug}-${datePart}-${timePart}.csv`;
}
