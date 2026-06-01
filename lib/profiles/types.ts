// Demo profile schema. Designed up front to cover every Phase 3 sub-phase
// (3a–3g). Most fields are unwired in 3a — the form sections that drive them
// land incrementally. Saved profiles always include every field so we don't
// need a migration step every time a new sub-phase ships; defaults make new
// fields zero-config for older profiles.
//
// SECURITY: profiles MAY be exported as JSON files and shared between team
// members. They MUST NOT contain API keys, passwords, or any user secret.
// The serializer in `lib/storage/profiles.ts` strips unknown fields before
// persistence; if you add a field, add it here too.

export type ProfileSchemaVersion = 1;
export const CURRENT_SCHEMA_VERSION: ProfileSchemaVersion = 1;

// ----------------------------------------------------------------------------
// 3b — themes & persona distribution
// ----------------------------------------------------------------------------

export interface ThemeConfig {
  id: string;
  label: string;
  /** Relative weight 0–100. Weights don't need to sum to anything. */
  weight: number;
}

export interface PersonaDistribution {
  promoter: number;
  passive: number;
  detractor: number;
}

// ----------------------------------------------------------------------------
// 3c — language distribution
// ----------------------------------------------------------------------------

export interface LanguageWeight {
  /** ISO 639-1 code, e.g. "en", "es", "fr" */
  code: string;
  /** 0–100; entries should sum to 100 (UI enforces this). */
  weight: number;
}

// ----------------------------------------------------------------------------
// Country filter
// ----------------------------------------------------------------------------

/**
 * An entry in the country filter. When the array is non-empty, Plumage
 * restricts each persona's country to those on this list (intersected with the
 * countries available for their assigned language). An empty array means
 * "no filter — follow the language distribution as-is".
 */
export interface CountryFilterEntry {
  /** ISO 3166-1 alpha-2, e.g. "US", "GB". */
  code: string;
  /** Human-readable, e.g. "United States". */
  name: string;
  /** Relative weight 0–100. Weights don't need to sum to 100. */
  weight: number;
}

// ----------------------------------------------------------------------------
// 3d — per-question distribution
// ----------------------------------------------------------------------------

export type RatingPreset =
  | "realistic"
  | "mostly_positive"
  | "mostly_negative"
  | "bell_curve"
  | "bimodal";

export interface RatingDistributionConfig {
  preset: RatingPreset;
  /** Optional fine-tune skew, -1..+1. Negative = toward low ratings. */
  skew?: number;
}

export interface ChoiceWeightConfig {
  /** Map of choice id (stringified) → relative weight 0–100. */
  weights: Record<string, number>;
}

export type OpenTextTone =
  | "professional"
  | "casual"
  | "frustrated"
  | "enthusiastic";

export type OpenTextLength = "terse" | "medium" | "verbose" | "mixed";

export interface OpenTextConfig {
  tones: OpenTextTone[];
  length: OpenTextLength;
}

// Discriminated union — `kind` tells us which shape `config` has.
export type QuestionConfig =
  | { kind: "rating"; config: RatingDistributionConfig }
  | { kind: "choice"; config: ChoiceWeightConfig }
  | { kind: "text"; config: OpenTextConfig };

// ----------------------------------------------------------------------------
// 3e — custom variables
// ----------------------------------------------------------------------------

export interface StringValueOption {
  text: string;
  /** Relative weight 0–100 across all options. Options should sum to 100. */
  weight: number;
}

/**
 * STRING variable configuration. Two generation modes:
 *
 *   - "options" (default; original behavior): each persona picks one of
 *     `options` by weight.
 *
 *   - "examples": user provides one or more example values; Plumage emits
 *     similar values per persona via pattern-based variation (digit runs
 *     in IDs are randomized; free-form text is picked verbatim with
 *     occasional case/whitespace variation). Cheap and deterministic —
 *     no per-response LLM calls.
 *
 * Both modes optionally allow a weighted BLANK output. When the persona
 * draws a blank, the variable is sent as an empty string `""` in the SS
 * payload (which SS treats as "not provided" without rejecting the
 * response). When `allowBlank` is true, `blankWeight` participates in
 * the weighted draw alongside options/examples.
 *
 * Backward compatibility: every new field is optional. A profile saved
 * before this schema change loads with mode=options + allowBlank=false.
 */
export interface StringValueConfig {
  /** Default: "options". Older profiles omit this field; readers must
   *  treat undefined as "options". */
  mode?: "options" | "examples";
  /** Weighted fixed options (used when mode === "options"). */
  options: StringValueOption[];
  /** Source patterns for example-based generation (used when mode === "examples"). */
  examples?: string[];
  /** When true, some responses get a blank value for this variable. */
  allowBlank?: boolean;
  /** Weight assigned to the blank outcome (0–100). Must sum with option/example weights to 100. */
  blankWeight?: number;
}

export interface NumberValueConfig {
  mode: "range" | "static";
  /** Inclusive lower bound (range mode). */
  min?: number;
  /** Inclusive upper bound (range mode). */
  max?: number;
  /** Fixed value emitted for every persona (static mode). */
  staticValue?: number;
  /**
   * When true, range-mode generation emits decimal values rounded to
   * `decimalPlaces`. Default: false (whole numbers — safer for counts,
   * IDs, NPS-style values). Static mode honors the literal value the user
   * entered regardless of this flag.
   */
  allowDecimals?: boolean;
  /** 1–4 decimal places when `allowDecimals` is true. Default: 2. */
  decimalPlaces?: number;
}

export interface DateValueConfig {
  mode: "relative" | "range";
  /** For "relative": N days back from submission time (1–365). */
  relativeDays?: number;
  /** For "range": Unix ms start. */
  start?: number;
  /** For "range": Unix ms end. */
  end?: number;
}

/**
 * Persona-field binding: at generation time, the variable's value is taken
 * verbatim from the named field of the Persona that produced this response.
 * Useful for placeholders like `$Param_customer_fn` in question text that
 * SS expects to substitute per-respondent.
 *
 * The `key` MUST match a field on `Persona` that's also exposed in
 * `PERSONA_FIELD_OPTIONS`. We deliberately whitelist — exposing the full
 * Persona surface would leak internal fields (`id`, `latitude`, etc.) into
 * the picker without serving a real demo use case.
 */
export type PersonaFieldKey =
  | "firstName"
  | "lastName"
  | "name"
  | "email"
  | "phone"
  | "city"
  | "countryName"
  | "country"
  | "language";

/**
 * Curated list of persona fields surfaced in the variable type picker.
 * Order is also the render order of the chip grid in the UI.
 */
export const PERSONA_FIELD_OPTIONS: Array<{
  key: PersonaFieldKey;
  label: string;
  example: string;
}> = [
  { key: "firstName", label: "First name", example: "Giovanna" },
  { key: "lastName", label: "Last name", example: "Gutkowski" },
  { key: "name", label: "Full name", example: "Giovanna Gutkowski" },
  { key: "email", label: "Email address", example: "giovanna.g@gmail.com" },
  { key: "phone", label: "Phone number", example: "+1 555-234-5678" },
  { key: "city", label: "City", example: "New York" },
  { key: "countryName", label: "Country (full)", example: "United States" },
  { key: "country", label: "Country (code)", example: "US" },
  { key: "language", label: "Language code", example: "en" },
];

export interface PersonaFieldValueConfig {
  field: PersonaFieldKey;
}

export type CustomVariableValues =
  | { kind: "string"; config: StringValueConfig }
  | { kind: "number"; config: NumberValueConfig }
  | { kind: "date"; config: DateValueConfig }
  | { kind: "persona_field"; config: PersonaFieldValueConfig };

export interface CustomVariable {
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Snake-case key used in the SS API, e.g. "sys_products". Max 35 chars. */
  apiIdentifier: string;
  type: "STRING" | "NUMBER" | "DATE" | "PERSONA";
  values: CustomVariableValues;
}

// ----------------------------------------------------------------------------
// 3f — system metadata  (mirrors SS POST /v3/responses meta_data fields)
// ----------------------------------------------------------------------------

export interface MetadataWeightedOption {
  value: string;
  weight: number;
}

export interface SystemMetadataConfig {
  /** Device type: Mobile, Desktop, Tablet. */
  device_type: { enabled: boolean; options: MetadataWeightedOption[] };
  /** Browser: Chrome, Safari, Firefox, Edge, Other. */
  browser: { enabled: boolean; options: MetadataWeightedOption[] };
  /** Operating system: Windows, macOS, iOS, Android, Linux. */
  os: { enabled: boolean; options: MetadataWeightedOption[] };
  /** Browser language — read-only, mirrors the language distribution. */
  browser_language: { enabled: boolean };
  /** Timezone — follow persona geography or force a single IANA TZ. */
  time_zone: { enabled: boolean; forceTimezone?: string };
  /** IP address simulation. */
  ip: { enabled: boolean; mode: "none" | "coherent" | "fixed"; fixedIp?: string };
  /** Response tags injected into SS. */
  tags: { enabled: boolean; values: string[] };
  /** Submission timestamp — driven by the timeRange config (3g). */
  date_time: { enabled: boolean };
  /** Survey language — read-only, mirrors the language distribution. */
  language: { enabled: boolean };
}

// ----------------------------------------------------------------------------
// 3g — time range & pattern
// ----------------------------------------------------------------------------

export type TimePattern =
  | "realistic_mix"
  | "uniform"
  | "recent_surge"
  | "campaign_burst";

export interface TimeRangeConfig {
  /** Unix ms */
  from: number;
  /** Unix ms */
  to: number;
  pattern: TimePattern;
  /** Weight responses toward Mon–Fri, 9am–6pm in the persona's timezone. */
  businessHoursWeight: boolean;
  /** Total number of synthetic responses to generate. Stored here so 3h can read it. */
  responseCount: number;
}

// ----------------------------------------------------------------------------
// Top-level profile
// ----------------------------------------------------------------------------

export interface DemoProfile {
  id: string;
  name: string;
  version: ProfileSchemaVersion;
  createdAt: number;
  updatedAt: number;
  // 3a
  useCase: string;
  // 3b
  themes: ThemeConfig[];
  personaDistribution: PersonaDistribution;
  // 3c
  languageDistribution: LanguageWeight[];
  // country filter (empty = no restriction, follow language distribution)
  countryFilter: CountryFilterEntry[];
  // 3d — keyed by stringified question id, only set per-question if user
  // overrides the defaults.
  questionConfigs: Record<string, QuestionConfig>;
  // 3e
  customVariables: CustomVariable[];
  // 3f
  systemMetadata: SystemMetadataConfig;
  // 3g
  timeRange: TimeRangeConfig;
}

// The "draft" type — same as a profile but without persistence metadata.
export type ProfileDraft = Omit<
  DemoProfile,
  "id" | "name" | "createdAt" | "updatedAt"
>;

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function defaultSystemMetadata(): SystemMetadataConfig {
  const d = new Date();
  const tag = `plumage-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return {
    device_type: {
      enabled: true,
      options: [
        { value: "Mobile", weight: 60 },
        { value: "Desktop", weight: 35 },
        { value: "Tablet", weight: 5 },
      ],
    },
    browser: {
      enabled: true,
      options: [
        { value: "Chrome", weight: 65 },
        { value: "Safari", weight: 20 },
        { value: "Firefox", weight: 8 },
        { value: "Edge", weight: 5 },
        { value: "Other", weight: 2 },
      ],
    },
    os: {
      enabled: true,
      options: [
        { value: "Windows", weight: 40 },
        { value: "iOS", weight: 25 },
        { value: "macOS", weight: 20 },
        { value: "Android", weight: 12 },
        { value: "Linux", weight: 3 },
      ],
    },
    browser_language: { enabled: true },
    time_zone: { enabled: true },
    ip: { enabled: false, mode: "none" },
    tags: { enabled: true, values: [tag] },
    date_time: { enabled: true },
    language: { enabled: true },
  };
}

export function defaultDraft(): ProfileDraft {
  const now = Date.now();
  return {
    version: CURRENT_SCHEMA_VERSION,
    useCase: "",
    themes: [],
    personaDistribution: { promoter: 60, passive: 25, detractor: 15 },
    languageDistribution: [{ code: "en", weight: 100 }],
    countryFilter: [],
    questionConfigs: {},
    customVariables: [],
    systemMetadata: defaultSystemMetadata(),
    timeRange: {
      from: now - NINETY_DAYS_MS,
      to: now,
      pattern: "realistic_mix",
      businessHoursWeight: true,
      responseCount: 200,
    },
  };
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a candidate DemoProfile (e.g. one being imported from JSON).
 * Returns a fully-populated, type-safe DemoProfile if valid, or a list of
 * errors. We deliberately accept partial profiles and fill missing fields
 * with defaults — older exports should keep working as we add fields.
 */
export function validateAndNormalizeProfile(
  candidate: unknown,
): { ok: true; profile: DemoProfile } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: [{ field: "root", message: "Not an object." }] };
  }
  const c = candidate as Record<string, unknown>;

  if (typeof c.id !== "string" || c.id.length === 0) {
    errors.push({ field: "id", message: "Missing id." });
  }
  if (typeof c.name !== "string" || c.name.trim().length === 0) {
    errors.push({ field: "name", message: "Missing or empty name." });
  }
  if (c.version !== undefined && c.version !== 1) {
    errors.push({
      field: "version",
      message: `Unsupported schema version: ${String(c.version)}. Expected 1.`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const defaults = defaultDraft();
  const profile: DemoProfile = {
    id: String(c.id),
    name: String(c.name).trim(),
    version: CURRENT_SCHEMA_VERSION,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : Date.now(),
    useCase: typeof c.useCase === "string" ? c.useCase : defaults.useCase,
    themes: Array.isArray(c.themes)
      ? (c.themes as ThemeConfig[]).filter(
          (t) => t && typeof t.id === "string" && typeof t.label === "string",
        )
      : defaults.themes,
    personaDistribution:
      isPersonaDistribution(c.personaDistribution)
        ? c.personaDistribution
        : defaults.personaDistribution,
    languageDistribution: Array.isArray(c.languageDistribution)
      ? (c.languageDistribution as LanguageWeight[]).filter(
          (l) => l && typeof l.code === "string" && typeof l.weight === "number",
        )
      : defaults.languageDistribution,
    countryFilter: Array.isArray(c.countryFilter)
      ? (c.countryFilter as CountryFilterEntry[]).filter(
          (e) =>
            e &&
            typeof e.code === "string" &&
            typeof e.name === "string" &&
            typeof e.weight === "number",
        )
      : defaults.countryFilter,
    questionConfigs:
      c.questionConfigs && typeof c.questionConfigs === "object"
        ? (c.questionConfigs as Record<string, QuestionConfig>)
        : defaults.questionConfigs,
    customVariables: Array.isArray(c.customVariables)
      ? (c.customVariables as CustomVariable[]).filter(
          (v) =>
            v &&
            typeof v.id === "string" &&
            typeof v.label === "string" &&
            typeof v.apiIdentifier === "string" &&
            v.values !== undefined,
        )
      : defaults.customVariables,
    systemMetadata: mergeSystemMetadata(c.systemMetadata),
    timeRange: normalizeTimeRange(c.timeRange, defaults.timeRange),
  };
  return { ok: true, profile };
}

function isPersonaDistribution(value: unknown): value is PersonaDistribution {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.promoter === "number" &&
    typeof v.passive === "number" &&
    typeof v.detractor === "number"
  );
}

/**
 * Merge a raw (possibly partial or old-schema) systemMetadata value against the
 * current defaults. Safe to call with `undefined`, old shapes, or partial objects
 * — every missing key is filled from `defaultSystemMetadata()`.
 */
export function mergeSystemMetadata(raw: unknown): SystemMetadataConfig {
  const d = defaultSystemMetadata();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<Record<keyof SystemMetadataConfig, unknown>>;
  return {
    device_type:
      r.device_type && typeof r.device_type === "object" && "enabled" in r.device_type
        ? (r.device_type as SystemMetadataConfig["device_type"])
        : d.device_type,
    browser:
      r.browser && typeof r.browser === "object" && "enabled" in r.browser
        ? (r.browser as SystemMetadataConfig["browser"])
        : d.browser,
    os:
      r.os && typeof r.os === "object" && "enabled" in r.os
        ? (r.os as SystemMetadataConfig["os"])
        : d.os,
    browser_language:
      r.browser_language && typeof r.browser_language === "object"
        ? (r.browser_language as SystemMetadataConfig["browser_language"])
        : d.browser_language,
    time_zone:
      r.time_zone && typeof r.time_zone === "object"
        ? (r.time_zone as SystemMetadataConfig["time_zone"])
        : d.time_zone,
    ip:
      r.ip && typeof r.ip === "object" && "mode" in r.ip
        ? (r.ip as SystemMetadataConfig["ip"])
        : d.ip,
    tags:
      r.tags && typeof r.tags === "object" && "values" in r.tags
        ? (r.tags as SystemMetadataConfig["tags"])
        : d.tags,
    date_time:
      r.date_time && typeof r.date_time === "object"
        ? (r.date_time as SystemMetadataConfig["date_time"])
        : d.date_time,
    language:
      r.language && typeof r.language === "object"
        ? (r.language as SystemMetadataConfig["language"])
        : d.language,
  };
}

function isSystemMetadata(value: unknown): value is SystemMetadataConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // New schema: per-field enabled+options objects (3f). Old shape had useDefaults/device/channels.
  return (
    v.device_type !== undefined &&
    typeof v.device_type === "object" &&
    v.browser !== undefined &&
    typeof v.browser === "object" &&
    v.os !== undefined &&
    typeof v.os === "object"
  );
}

function normalizeTimeRange(raw: unknown, def: TimeRangeConfig): TimeRangeConfig {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  // Accept both old field names (start/end) and new (from/to).
  const from =
    typeof r.from === "number" ? r.from
    : typeof r.start === "number" ? r.start
    : def.from;
  const to =
    typeof r.to === "number" ? r.to
    : typeof r.end === "number" ? r.end
    : def.to;
  let pattern: TimeRangeConfig["pattern"] = def.pattern;
  if (typeof r.pattern === "string") {
    const p = r.pattern;
    if (p === "uniform") pattern = "uniform";
    else if (p === "recent_skew" || p === "recent_surge") pattern = "recent_surge";
    else if (p === "campaign_burst") pattern = "campaign_burst";
    else pattern = "realistic_mix";
  }
  return {
    from,
    to,
    pattern,
    businessHoursWeight:
      typeof r.businessHoursWeight === "boolean" ? r.businessHoursWeight : def.businessHoursWeight,
    responseCount:
      typeof r.responseCount === "number" ? r.responseCount : def.responseCount,
  };
}
