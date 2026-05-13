// CSV export constants and types for the SurveySparrow Response Migration
// marketplace app.
//
// ─── Column ordering (deterministic) ────────────────────────────────────────
// 1. System metadata    — SS response properties (Created At … Tags)
// 2. Contact properties — Full Name, Email, Phone  (from persona identity)
// 3. Custom variables   — one column per variable; header = apiIdentifier
//                         (no prefix — matches the key the SS API uses)
// 4. Survey questions   — survey position order; header = question text
//                         truncated to MAX_HEADER_LENGTH chars.
//                         Multi-column types (Matrix, GroupRating, ConstantSum)
//                         expand inline immediately after the parent question's
//                         position, with headers "{QuestionText} - {RowLabel}".
//
// Rationale: metadata first keeps the sheet human-readable on first open;
// contact columns mirror the SS "contact" payload block; custom variables
// precede question answers because they're structural, not respondent choices.

// ---------------------------------------------------------------------------
// Hard limits
// ---------------------------------------------------------------------------

/** SS Response Migration app accepts at most 5,000 rows per upload. */
export const MAX_CSV_ROWS = 5_000;

/** Column header character limit — truncated with "…" if exceeded. */
export const MAX_HEADER_LENGTH = 200;

// ---------------------------------------------------------------------------
// Language display-name map
// ---------------------------------------------------------------------------

/**
 * Language code → full English display name for the "Language" metadata column.
 *
 * The SS importer expects a human-readable string (e.g., "English"), not an
 * ISO code. Covers all 13 languages available in the language distribution
 * picker. Falls back to the raw code if not found.
 */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
  zh: "Chinese",
  ar: "Arabic",
  hi: "Hindi",
  ko: "Korean",
  ru: "Russian",
};

// ---------------------------------------------------------------------------
// Fixed column headers
// ---------------------------------------------------------------------------

/**
 * System metadata columns — always present, in this exact order.
 * Matches the SS importer's "Supported Response Properties" list.
 */
export const SYSTEM_COL_HEADERS = [
  "Created At",
  "Browser",
  "OS",
  "Device Type",
  "Time Zone",
  "IP Address",
  "Browser Language",
  "Language",
  "Tags",
] as const;

export type SystemColHeader = (typeof SYSTEM_COL_HEADERS)[number];

/**
 * Contact property columns — always present, populated from persona identity.
 * Mirrors the SS contact block (full_name / email / phone).
 */
export const CONTACT_COL_HEADERS = ["Full Name", "Email", "Phone"] as const;

// ---------------------------------------------------------------------------
// Question-type classification
// ---------------------------------------------------------------------------

/**
 * Question type buckets (from question-types.ts) that produce NO column in
 * the CSV. These are either structural non-answers (welcome/thank-you screens,
 * consent messages) or unsupported media types.
 *
 * "contact" bucket covers email/phone/address/contactform — persona contact
 * data lives in the Contact columns instead of repeating it as question cells.
 */
export const SKIPPED_BUCKETS = new Set([
  "screen",   // welcome, thank-you, message, consent
  "file",     // file upload
  "voice",    // audio recording
  "video",    // video
  "contact",  // email, phone, address, contact form
]);

/**
 * Canonical question-type keys (from getQuestionTypeMeta().canonical) that
 * expand into multiple CSV columns — one per row/statement/option.
 *
 * For each such question, buildQuestionColumns calls extractQuestionRows to
 * generate the per-row column descriptors with headers:
 *   "{QuestionText} - {RowLabel}"
 */
export const MULTI_COL_CANONICALS = new Set([
  "matrix",        // Matrix / BipolarMatrix (canonical "matrix" after alias mapping)
  "grouprating",   // GroupRating (each statement → own column)
  "constantsum",   // ConstantSum (each option → own column)
]);

// ---------------------------------------------------------------------------
// Internal column descriptor (not exported — used only inside csv-exporter.ts)
// ---------------------------------------------------------------------------

export interface QuestionColumn {
  /** CSV column header string (already truncated to MAX_HEADER_LENGTH). */
  header: string;
  /** Parent question id — key into response.answers. */
  questionId: number;
  /**
   * The full Question object, carried so serializeAnswerWithQuestion can
   * resolve scale-point / choice IDs to their display labels (matrix_single,
   * matrix_multiple, matrix_dropdown, ranking). Without this, cells would
   * contain raw numeric IDs instead of strings like "Poor" / "Excellent".
   */
  question: import("@/lib/surveysparrow/types").Question;
  /**
   * For multi-column types: the row's ExtractedRow.id stringified.
   * Used to index into the answer's rows Record<string, …> object.
   * Undefined for single-value question columns.
   */
  rowId?: string;
}
