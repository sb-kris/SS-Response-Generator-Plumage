// Phase 8 — Validator for the Setup Assistant LLM output.
//
// Mirrors the persona-validator pattern: never throw, always return a
// normalised SetupAssistantLLMOutput plus an array of validation errors.
// Callers can choose to retry with `summarizeValidationErrors` fed back
// into the prompt, or surrender and accept the (possibly degraded)
// output as-is.

import {
  isValidApiIdentifier,
  normaliseApiIdentifier,
  type SetupAssistantLLMOutput,
} from "@/lib/generation/setup-assistant-types";

export interface SetupValidationError {
  /** Which field failed — e.g. "themes[2].weight" or "customVariables[0].apiIdentifier". */
  field: string;
  message: string;
}

export interface SetupValidationResult {
  ok: boolean;
  output: SetupAssistantLLMOutput;
  errors: SetupValidationError[];
}

// Defensive constants so a misbehaving model can't crash the route.
const CONTEXT_MIN_CHARS = 120;
const CONTEXT_MAX_CHARS = 800;
const THEMES_MIN = 3;
const THEMES_MAX = 8;
const VARIABLES_MIN = 0; // tolerated empty — the LLM may have nothing useful
// Raised from 8 → 24 so the LLM can enrich large SS workspaces (we've
// seen 18 existing variables in the wild) without losing entries. Output
// tokens are still bounded by the route's maxOutputTokens budget.
const VARIABLES_MAX = 24;

// Placeholder-detection regex — used to reject "Sample value A", "Value 1",
// "Option 1", etc. that signal the LLM gave up trying to ground the
// option in real context. We'd rather show NO option than a generic one
// the user has to rewrite.
const PLACEHOLDER_TEXT_REGEX = /^(sample(\s+(value|option))?|value|option|placeholder|example)\s*[a-z]?\s*\d*$/i;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 6;

const FALLBACK_CONTEXT =
  "Synthesize realistic demo respondents for this survey based on the company's likely customer base.";

export function validateSetupAssistantOutput(parsed: unknown): SetupValidationResult {
  const errors: SetupValidationError[] = [];

  if (!parsed || typeof parsed !== "object") {
    errors.push({ field: "envelope", message: "Expected a JSON object, got " + typeof parsed });
    return { ok: false, output: emptyOutput(), errors };
  }

  const p = parsed as Record<string, unknown>;

  // ---- context ----
  let context = typeof p.context === "string" ? p.context.trim() : "";
  if (!context) {
    errors.push({ field: "context", message: "Missing or empty." });
    context = FALLBACK_CONTEXT;
  } else if (context.length < CONTEXT_MIN_CHARS) {
    errors.push({
      field: "context",
      message: `Too short (${context.length} chars) — expected ${CONTEXT_MIN_CHARS}+`,
    });
    // Keep it — degraded but usable.
  } else if (context.length > CONTEXT_MAX_CHARS) {
    context = context.slice(0, CONTEXT_MAX_CHARS - 1) + "…";
    errors.push({ field: "context", message: "Truncated (exceeded max length)." });
  }

  // ---- themes ----
  const themesRaw = Array.isArray(p.themes) ? p.themes : [];
  if (themesRaw.length < THEMES_MIN) {
    errors.push({
      field: "themes",
      message: `Expected ${THEMES_MIN}-${THEMES_MAX} themes, got ${themesRaw.length}`,
    });
  }
  const themes: SetupAssistantLLMOutput["themes"] = [];
  const seenThemeLabels = new Set<string>();
  for (let i = 0; i < themesRaw.length && themes.length < THEMES_MAX; i++) {
    const t = themesRaw[i];
    if (!t || typeof t !== "object") continue;
    const obj = t as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!label) {
      errors.push({ field: `themes[${i}].label`, message: "Missing label." });
      continue;
    }
    const lc = label.toLowerCase();
    if (seenThemeLabels.has(lc)) {
      errors.push({ field: `themes[${i}].label`, message: "Duplicate theme label." });
      continue;
    }
    seenThemeLabels.add(lc);
    let weight = typeof obj.weight === "number" ? Math.round(obj.weight) : 10;
    if (!Number.isFinite(weight) || weight < 1) weight = 10;
    if (weight > 100) weight = 100;
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : undefined;
    themes.push({ label: label.slice(0, 60), weight, reason });
  }

  // ---- customVariables ----
  const varsRaw = Array.isArray(p.customVariables) ? p.customVariables : [];
  if (varsRaw.length > VARIABLES_MAX) {
    errors.push({
      field: "customVariables",
      message: `Too many variables (${varsRaw.length}) — keeping first ${VARIABLES_MAX}.`,
    });
  }
  const variables: SetupAssistantLLMOutput["customVariables"] = [];
  const seenIdentifiers = new Set<string>();
  for (let i = 0; i < Math.min(varsRaw.length, VARIABLES_MAX); i++) {
    const v = varsRaw[i];
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!label) {
      errors.push({ field: `customVariables[${i}].label`, message: "Missing label." });
      continue;
    }
    // apiIdentifier — coerce to the codebase's rule, drop if irrecoverable.
    let apiIdentifier = typeof obj.apiIdentifier === "string" ? obj.apiIdentifier.trim() : "";
    if (!apiIdentifier || !isValidApiIdentifier(apiIdentifier)) {
      const normalised = apiIdentifier ? normaliseApiIdentifier(apiIdentifier) : null;
      if (!normalised) {
        errors.push({
          field: `customVariables[${i}].apiIdentifier`,
          message: `Invalid identifier "${apiIdentifier}" — dropped variable.`,
        });
        continue;
      }
      apiIdentifier = normalised;
      errors.push({
        field: `customVariables[${i}].apiIdentifier`,
        message: `Coerced identifier to "${apiIdentifier}".`,
      });
    }
    if (seenIdentifiers.has(apiIdentifier)) {
      errors.push({
        field: `customVariables[${i}].apiIdentifier`,
        message: `Duplicate identifier "${apiIdentifier}" — dropped.`,
      });
      continue;
    }
    seenIdentifiers.add(apiIdentifier);

    // options — we accept STRING-typed only for now (matches the LLM
    // contract). Any other "type" gets coerced to STRING; the model
    // already knows from the prompt to use STRING.
    //
    // Placeholder rejection: text matching "Sample value A", "Value 1",
    // "Option A", "Placeholder", etc. is silently dropped. The LLM
    // sometimes falls back to these when it can't ground a variable in
    // the company / survey context — we'd rather drop the variable
    // entirely than ship lazy fillers the user has to rewrite.
    const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: Array<{ text: string; weight: number }> = [];
    const seenOptionTexts = new Set<string>();
    let placeholdersSeen = 0;
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      const text = typeof o.text === "string" ? o.text.trim() : "";
      if (!text) continue;
      // Reject placeholder filler — keep counter for warning.
      if (PLACEHOLDER_TEXT_REGEX.test(text)) {
        placeholdersSeen += 1;
        continue;
      }
      // De-dupe option text within the same variable (case-insensitive).
      const dedupKey = text.toLowerCase();
      if (seenOptionTexts.has(dedupKey)) continue;
      seenOptionTexts.add(dedupKey);

      let weight = typeof o.weight === "number" ? Math.round(o.weight) : Math.round(100 / Math.max(1, optionsRaw.length));
      if (!Number.isFinite(weight) || weight < 1) weight = 1;
      if (weight > 100) weight = 100;
      options.push({ text: text.slice(0, 80), weight });
      if (options.length >= OPTIONS_MAX) break;
    }
    if (options.length < OPTIONS_MIN) {
      const msg = placeholdersSeen > 0
        ? `Too few real options (${options.length}) — dropped ${placeholdersSeen} placeholder filler${placeholdersSeen === 1 ? "" : "s"}.`
        : `Too few options (${options.length}) — dropped variable.`;
      errors.push({ field: `customVariables[${i}].options`, message: msg });
      continue;
    }

    // source — optional. The LLM SHOULD set this to "surveysparrow_variable"
    // when enriching an existing workspace variable so the dialog knows
    // not to recreate it at push time. We don't error if it's missing —
    // the dialog falls back to apiIdentifier-matching against the SS list.
    const rawSource = typeof obj.source === "string" ? obj.source.trim().toLowerCase() : "";
    const source: "ai_suggested" | "surveysparrow_variable" | undefined =
      rawSource === "surveysparrow_variable" || rawSource === "ss" || rawSource === "surveysparrow"
        ? "surveysparrow_variable"
        : rawSource === "ai_suggested" || rawSource === "ai"
          ? "ai_suggested"
          : undefined;

    const reason = typeof obj.reason === "string" ? obj.reason.trim() : undefined;
    variables.push({
      label: label.slice(0, 64),
      apiIdentifier,
      type: "STRING",
      ...(source ? { source } : {}),
      options,
      reason,
    });
  }
  void VARIABLES_MIN; // explicit "we don't enforce a lower bound"

  // ---- warnings (passthrough — LLM may surface its own notes) ----
  const warningsRaw = Array.isArray(p.warnings) ? p.warnings : [];
  const warnings: string[] = warningsRaw
    .filter((w): w is string => typeof w === "string")
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, 5);

  const output: SetupAssistantLLMOutput = {
    context,
    themes,
    customVariables: variables,
    warnings,
  };

  // OK = no envelope errors AND at least 1 theme AND at least 1 variable
  // (or the user gets a near-empty preview, which we treat as soft fail).
  const ok = themes.length > 0 && errors.filter((e) => e.field === "envelope").length === 0;
  return { ok, output, errors };
}

export function summarizeSetupErrors(errors: SetupValidationError[]): string {
  if (errors.length === 0) return "";
  const head = errors.slice(0, 4).map((e) => `${e.field}: ${e.message}`);
  const tail = errors.length > 4 ? ` (+${errors.length - 4} more)` : "";
  return head.join(" | ") + tail;
}

function emptyOutput(): SetupAssistantLLMOutput {
  return { context: FALLBACK_CONTEXT, themes: [], customVariables: [], warnings: [] };
}
