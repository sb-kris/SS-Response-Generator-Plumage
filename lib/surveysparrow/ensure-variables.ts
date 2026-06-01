// Phase 8c — Pre-push variable readiness check.
//
// Called from usePushResponses.push() BEFORE the batch loop runs. The
// goal: any custom variable in the draft must already exist in the
// SurveySparrow workspace before we ship responses referencing it,
// otherwise SS rejects the push with a generic "variable not found"
// error that surfaced as "survey generation failed" in the UI.
//
// Three-step orchestration:
//   1. GET /api/surveysparrow/variables → existing workspace variables
//      for the survey.
//   2. Diff draft.customVariables against the existing set
//      (case-insensitive by apiIdentifier/name).
//   3. POST /api/surveysparrow/variables/batch with the missing ones.
//
// Failure semantics: if creation partially fails, we surface the
// failure and the caller stops the push. Better to surface a specific
// error than push some responses and lose others.
//
// SECURITY: API key flows through props; never persisted. The internal
// routes already enforce no-store / no-log.

import type { CustomVariable } from "@/lib/profiles/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnsureVariablesInput {
  region: string;
  apiKey: string;
  surveyId: number;
  /** The full draft customVariables list — we filter to what needs creating. */
  variables: CustomVariable[];
  /** Progress callback fired as we advance through steps. Optional. */
  onProgress?: (event: EnsureProgressEvent) => void;
  signal?: AbortSignal;
}

export type EnsureProgressEvent =
  | { kind: "checking" }
  | { kind: "checked"; existing: number; missing: number }
  | { kind: "creating"; missing: number }
  | { kind: "ready"; existing: number; created: number };

export interface EnsureVariablesResult {
  ok: boolean;
  /** How many variables already existed before we touched anything. */
  existingCount: number;
  /** How many variables we created in this run. */
  createdCount: number;
  /** Variables that should have been created but failed — by name. */
  failedNames: string[];
  /** First/most helpful error message, if creation failed. */
  errorMessage?: string;
  /**
   * Lowercased names of variables that SS auto-populates from the response
   * contact / persona (e.g. FIRST_NAME → persona.firstName). The push must
   * NOT include values for these — SS rejects the entire response with
   * "Invalid value passed or missing values in payload" when we try to
   * write to a persona-bound variable.
   *
   * The caller passes this list to buildSSBatchPayload via
   * PushOptions.excludeVariableNames so the response-builder filters them
   * out before serializing.
   */
  excludeFromPayload: string[];
  /**
   * Lowercased names of variables whose SS type is "DATE". These need
   * special formatting at push time — SS rejects YYYY-MM-DD values for
   * DATE-typed columns with the misleading "Custom Property not found"
   * error and expects ISO 8601 datetimes ("2026-01-11T00:00:00.000Z")
   * instead.
   *
   * Passed to buildSSBatchPayload via PushOptions.dateVariableNames so the
   * response-builder can coerce values for those keys.
   */
  dateVariableNames: string[];
}

interface ExistingVariableShape {
  id?: number;
  name?: string;
  label?: string;
  type?: string;
  /** Set when the variables route detected a persona binding. */
  personaBinding?: string;
}

// ---------------------------------------------------------------------------
// Plumage → SurveySparrow type mapping
// ---------------------------------------------------------------------------

/**
 * Plumage has a "PERSONA" variable type that resolves to a string at
 * generation time (e.g. firstName, city). SS doesn't model that — for
 * SS creation purposes, persona variables are just STRING. Any unknown
 * type maps to STRING as a safe default.
 */
function mapTypeForSurveySparrow(t: CustomVariable["type"]): "STRING" | "NUMBER" | "DATE" {
  if (t === "NUMBER") return "NUMBER";
  if (t === "DATE") return "DATE";
  // STRING + PERSONA + anything else → STRING.
  return "STRING";
}

// ---------------------------------------------------------------------------
// Main entry — used by usePushResponses
// ---------------------------------------------------------------------------

export async function ensureSurveyVariablesExist(
  input: EnsureVariablesInput,
): Promise<EnsureVariablesResult> {
  // Fast path: nothing in the draft to verify.
  if (input.variables.length === 0) {
    return { ok: true, existingCount: 0, createdCount: 0, failedNames: [], excludeFromPayload: [], dateVariableNames: [] };
  }

  input.onProgress?.({ kind: "checking" });

  // ---- Step 1: fetch existing variables for the survey ----
  let existing: ExistingVariableShape[];
  try {
    const fetched = await fetch("/api/surveysparrow/variables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: input.region,
        apiKey: input.apiKey,
        surveyId: input.surveyId,
      }),
      signal: input.signal,
      cache: "no-store",
    });
    const json = (await fetched.json()) as {
      ok: boolean;
      variables?: ExistingVariableShape[];
      error?: string;
    };
    if (!json.ok) {
      return {
        ok: false,
        existingCount: 0,
        createdCount: 0,
        failedNames: [],
        excludeFromPayload: [],
        dateVariableNames: [],
        errorMessage: `Couldn't read existing variables: ${json.error ?? "unknown error"}`,
      };
    }
    existing = Array.isArray(json.variables) ? json.variables : [];
  } catch (err) {
    return {
      ok: false,
      existingCount: 0,
      createdCount: 0,
      failedNames: [],
      excludeFromPayload: [],
      dateVariableNames: [],
      errorMessage:
        err instanceof Error
          ? `Couldn't reach the variables endpoint: ${err.message}`
          : "Couldn't reach the variables endpoint.",
    };
  }

  // Collect persona-bound variable names ONCE — used by both the
  // checked-only fast path and the create-then-ready path below.
  // SS auto-populates these from the contact persona, so we mustn't
  // include them in the response push payload.
  const excludeFromPayload: string[] = [];
  // Collect DATE-typed variable names. SS requires ISO 8601 datetime
  // values for these columns; the response-builder uses this list to
  // coerce YYYY-MM-DD generation output to ISO datetime at push time.
  const dateVariableNames: string[] = [];
  for (const v of existing) {
    if (typeof v.name !== "string") continue;
    const lowerName = v.name.trim().toLowerCase();
    if (v.personaBinding) {
      excludeFromPayload.push(lowerName);
    }
    if (typeof v.type === "string" && v.type.trim().toUpperCase() === "DATE") {
      dateVariableNames.push(lowerName);
    }
  }

  // ---- Step 2: diff ----
  // Compare by lowercased name. SS appears case-insensitive on creation;
  // matching the same way prevents redundant create attempts.
  const existingNamesLower = new Set<string>();
  for (const v of existing) {
    if (typeof v.name === "string" && v.name.trim()) {
      existingNamesLower.add(v.name.trim().toLowerCase());
    }
  }
  const missing = input.variables.filter(
    (v) => v.apiIdentifier && !existingNamesLower.has(v.apiIdentifier.toLowerCase()),
  );
  // De-dupe within the missing list (shouldn't happen — the form
  // validator already enforces unique identifiers in the draft — but
  // safer to enforce here than to depend on it).
  const seen = new Set<string>();
  const uniqueMissing: CustomVariable[] = [];
  for (const v of missing) {
    const key = v.apiIdentifier.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMissing.push(v);
  }

  input.onProgress?.({
    kind: "checked",
    existing: existing.length,
    missing: uniqueMissing.length,
  });

  if (uniqueMissing.length === 0) {
    return {
      ok: true,
      existingCount: existing.length,
      createdCount: 0,
      failedNames: [],
      excludeFromPayload,
      dateVariableNames,
    };
  }

  // ---- Step 3: create missing ----
  input.onProgress?.({ kind: "creating", missing: uniqueMissing.length });

  const payloadVariables = uniqueMissing.map((v) => ({
    label: (v.label || v.apiIdentifier).slice(0, 500),
    name: v.apiIdentifier,
    description: "Created by Plumage for demo response generation",
    type: mapTypeForSurveySparrow(v.type),
  }));

  let created: number;
  let failedNames: string[] = [];
  let errorMessage: string | undefined;
  try {
    const res = await fetch("/api/surveysparrow/variables/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: input.region,
        apiKey: input.apiKey,
        surveyId: input.surveyId,
        variables: payloadVariables,
      }),
      signal: input.signal,
      cache: "no-store",
    });
    const json = (await res.json()) as {
      ok: boolean;
      created?: Array<{ name?: string }>;
      failed?: Array<{ name: string; error: string }>;
      error?: string;
    };
    created = Array.isArray(json.created) ? json.created.length : 0;
    if (!json.ok) {
      failedNames = Array.isArray(json.failed)
        ? json.failed.map((f) => f.name)
        : uniqueMissing.map((v) => v.apiIdentifier);
      errorMessage = json.error ?? "Failed to create variables in SurveySparrow.";
    }
  } catch (err) {
    return {
      ok: false,
      existingCount: existing.length,
      createdCount: 0,
      failedNames: uniqueMissing.map((v) => v.apiIdentifier),
      excludeFromPayload,
      dateVariableNames,
      errorMessage:
        err instanceof Error
          ? `Variable creation failed: ${err.message}`
          : "Variable creation failed.",
    };
  }

  const allOk = failedNames.length === 0;
  if (allOk) {
    input.onProgress?.({
      kind: "ready",
      existing: existing.length,
      created,
    });
  }

  return {
    ok: allOk,
    existingCount: existing.length,
    createdCount: created,
    failedNames,
    excludeFromPayload,
    dateVariableNames,
    errorMessage,
  };
}
