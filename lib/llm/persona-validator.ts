// Hand-rolled validator + normalizer for the persona JSON the LLM returns.
//
// We deliberately avoid Zod here — the schema is small, project policy keeps
// `node_modules` lean, and a focused validator gives us clearer error
// messages to feed back into a retry prompt.
//
// On invalid input we return a list of field-level errors. The caller
// decides whether to retry or to fall back to defaults for the affected
// personas.

import type {
  PersonaLLMOutput,
  SentimentArchetype,
  Verbosity,
} from "@/lib/generation/persona-types";

export interface PersonaValidationError {
  /** Position of the offending persona in the array (0-based), or -1 for envelope errors. */
  index: number;
  field: string;
  message: string;
}

export interface PersonaValidationResult {
  ok: boolean;
  /** Always populated — one entry per expected persona. Defaults are filled in for invalid items so the caller can keep going. */
  personas: PersonaLLMOutput[];
  errors: PersonaValidationError[];
}

const ARCHETYPES: SentimentArchetype[] = ["promoter", "passive", "detractor"];
const VERBOSITIES: Verbosity[] = ["terse", "medium", "verbose"];

/**
 * Validate the parsed JSON. `expectedCount` is the number of personas the
 * caller asked for — we use it to pad/truncate the array if the LLM
 * over- or under-produces.
 */
export function validatePersonaOutput(
  parsed: unknown,
  expectedCount: number,
  fallbackArchetypes: SentimentArchetype[],
): PersonaValidationResult {
  const errors: PersonaValidationError[] = [];

  // Envelope check.
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      personas: padDefaults(expectedCount, fallbackArchetypes),
      errors: [{ index: -1, field: "root", message: "Output is not an object." }],
    };
  }

  const root = parsed as Record<string, unknown>;
  // Accept either { personas: [...] } or a bare array. Some models lean toward
  // the latter despite the schema in the prompt.
  let arr: unknown;
  if (Array.isArray(root)) {
    arr = root;
  } else if (Array.isArray(root.personas)) {
    arr = root.personas;
  } else {
    return {
      ok: false,
      personas: padDefaults(expectedCount, fallbackArchetypes),
      errors: [
        {
          index: -1,
          field: "personas",
          message: "Missing top-level `personas` array.",
        },
      ],
    };
  }

  const items = arr as unknown[];

  // We tolerate length mismatch — we'll fill the gap with defaults — but
  // record it as an error so retries trigger.
  if (items.length !== expectedCount) {
    errors.push({
      index: -1,
      field: "personas",
      message: `Expected ${expectedCount} personas, got ${items.length}.`,
    });
  }

  const out: PersonaLLMOutput[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const raw = items[i];
    const archetype = fallbackArchetypes[i] ?? "passive";
    if (!raw || typeof raw !== "object") {
      errors.push({ index: i, field: "root", message: "Persona entry missing or not an object." });
      out.push(defaultLLMOutput(archetype));
      continue;
    }
    const obj = raw as Record<string, unknown>;

    // sentimentArchetype
    let sentiment: SentimentArchetype = archetype;
    if (typeof obj.sentimentArchetype === "string") {
      const v = obj.sentimentArchetype.toLowerCase();
      if (ARCHETYPES.includes(v as SentimentArchetype)) {
        sentiment = v as SentimentArchetype;
      } else {
        errors.push({
          index: i,
          field: "sentimentArchetype",
          message: `Invalid value: ${obj.sentimentArchetype}. Expected one of ${ARCHETYPES.join(", ")}.`,
        });
      }
    } else {
      errors.push({
        index: i,
        field: "sentimentArchetype",
        message: "Missing or non-string.",
      });
    }

    // keyConcerns
    let keyConcerns: string[];
    if (Array.isArray(obj.keyConcerns)) {
      keyConcerns = obj.keyConcerns
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .slice(0, 6);
      if (keyConcerns.length < 2) {
        errors.push({
          index: i,
          field: "keyConcerns",
          message: `Expected 2-6 entries, got ${keyConcerns.length}.`,
        });
        keyConcerns = padConcerns(keyConcerns, sentiment);
      }
    } else {
      errors.push({ index: i, field: "keyConcerns", message: "Missing or not an array." });
      keyConcerns = defaultConcerns(sentiment);
    }

    // themesTouched — empty is valid (config may have 0 themes configured).
    let themesTouched: string[];
    if (Array.isArray(obj.themesTouched)) {
      themesTouched = obj.themesTouched
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 4);
    } else {
      errors.push({ index: i, field: "themesTouched", message: "Missing or not an array." });
      themesTouched = [];
    }

    // verbosity
    let verbosity: Verbosity = "medium";
    if (typeof obj.verbosity === "string") {
      const v = obj.verbosity.toLowerCase();
      if (VERBOSITIES.includes(v as Verbosity)) {
        verbosity = v as Verbosity;
      } else {
        errors.push({
          index: i,
          field: "verbosity",
          message: `Invalid value: ${obj.verbosity}. Expected one of ${VERBOSITIES.join(", ")}.`,
        });
      }
    } else {
      errors.push({ index: i, field: "verbosity", message: "Missing or non-string." });
    }

    // demographicNotes
    let demographicNotes = "";
    if (typeof obj.demographicNotes === "string") {
      demographicNotes = obj.demographicNotes.trim().slice(0, 200);
    } else {
      errors.push({
        index: i,
        field: "demographicNotes",
        message: "Missing or non-string.",
      });
    }

    out.push({
      sentimentArchetype: sentiment,
      keyConcerns,
      themesTouched,
      verbosity,
      demographicNotes,
    });
  }

  return {
    ok: errors.length === 0,
    personas: out,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Defaults — used when the LLM call fails outright for a persona. Phrased
// generically so they don't betray the fallback path in the UI.
// ---------------------------------------------------------------------------

function defaultLLMOutput(archetype: SentimentArchetype): PersonaLLMOutput {
  return {
    sentimentArchetype: archetype,
    keyConcerns: defaultConcerns(archetype),
    themesTouched: [],
    verbosity: "medium",
    demographicNotes: defaultDemographicNotes(archetype),
  };
}

function defaultConcerns(archetype: SentimentArchetype): string[] {
  if (archetype === "promoter") {
    return ["product reliability", "ease of use", "responsive support"];
  }
  if (archetype === "detractor") {
    return ["pricing concerns", "missing features", "poor support response"];
  }
  return ["general usability", "value for money", "feature parity"];
}

function padConcerns(existing: string[], archetype: SentimentArchetype): string[] {
  const defaults = defaultConcerns(archetype);
  const out = [...existing];
  for (const d of defaults) {
    if (out.length >= 3) break;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

function defaultDemographicNotes(archetype: SentimentArchetype): string {
  if (archetype === "promoter") {
    return "An engaged customer who has had positive experiences with the product.";
  }
  if (archetype === "detractor") {
    return "A frustrated customer with unmet expectations.";
  }
  return "A neutral user with mixed but unremarkable experiences.";
}

function padDefaults(
  count: number,
  fallbackArchetypes: SentimentArchetype[],
): PersonaLLMOutput[] {
  return Array.from({ length: count }, (_, i) =>
    defaultLLMOutput(fallbackArchetypes[i] ?? "passive"),
  );
}

// ---------------------------------------------------------------------------
// Format errors into a one-line summary the retry prompt can use.
// ---------------------------------------------------------------------------

export function summarizeValidationErrors(errors: PersonaValidationError[]): string {
  if (errors.length === 0) return "";
  const sample = errors.slice(0, 3).map((e) => {
    const where = e.index === -1 ? "envelope" : `persona ${e.index + 1}`;
    return `${where}.${e.field}: ${e.message}`;
  });
  if (errors.length > 3) sample.push(`(+${errors.length - 3} more)`);
  return sample.join(" | ");
}
