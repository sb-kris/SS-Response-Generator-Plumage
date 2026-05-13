// Phase 5a — Response generation orchestrator.
//
// Mirrors `persona-synthesizer.ts` structurally — bounded-concurrency pool,
// async-generator with an event queue + wake-promise so events flow as
// soon as workers produce them. Per-persona work:
//
//   1) Build the response prompt (skipping non-answerable questions)
//   2) Call the LLM (provider-agnostic via `callLLMForJson`)
//   3) Validate the result against per-question-type rules
//   4) On failure: retry up to 2 times with the validation error fed back
//      into the prompt
//   5) Settle as success (clean answers) or warning (partial answers,
//      retries exhausted)
//
// Concurrency is provider-aware: 8 for Anthropic, 5 for OpenAI (tighter
// rate limits there).
//
// SECURITY: credentials are passed through; never logged or persisted.

import { getProviderConcurrency, type LLMProvider } from "@/lib/llm/models";
import type { Persona } from "./persona-types";
import type {
  AnswerType,
  AnswerValue,
  GeneratedResponse,
  GenerateResponsesEvent,
} from "./response-types";
import type { Question } from "@/lib/surveysparrow/types";
import {
  buildResponsePrompt,
  buildBatchResponsePrompt,
  type SurveyContext,
} from "@/lib/llm/prompts/response-prompt";
import { callLLMForJson } from "@/lib/llm/json-call";
import {
  summarizeResponseValidationErrors,
  validateResponseOutput,
} from "@/lib/llm/response-validator";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Concurrency: higher values reduce wall-clock time but increase burst
// token spend. Per-provider defaults are sourced from the model registry
// (`getProviderConcurrency`) so a new provider's settings live in ONE place.
/** Validation retries per persona/group (independent of rate-limit retries). */
const MAX_RETRIES = 2;
/** Independent budget for rate-limit retries. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** Default sleep when upstream returns 429 without a Retry-After header.
 *  Reduced from 30 s → 8 s. With exponential back-off the actual per-worker
 *  sequence is 1 s → 2 s → 4 s → 8 s → 8 s (15–23 s total vs old 150 s). */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 8_000;
/** Floor for exponential back-off. 1 s is short enough to be responsive
 *  and long enough to let a token-bucket refill a little. */
const MIN_RATE_LIMIT_BACKOFF_MS = 1_000;
/** Output token budget per single persona. */
const MAX_OUTPUT_TOKENS = 4_096;
/** Output token budget for a group of RESPONSE_GROUP_SIZE personas.
 *  Set to 2× per-persona budget; most providers support ≥8 192 output tokens. */
const MAX_BATCH_OUTPUT_TOKENS = 8_192;
/** Number of personas bundled into one LLM call to reduce API round-trips.
 *  2 personas per call ≈ 2× reduction in LLM calls, with minimal quality impact. */
const RESPONSE_GROUP_SIZE = 2;
/** Soft input-token budget check (4 chars ≈ 1 token). Warns but doesn't block. */
const SOFT_INPUT_TOKEN_BUDGET = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateResponsesInput {
  personas: Persona[];
  questions: Question[];
  surveyContext: SurveyContext;
  credentials: {
    provider: LLMProvider;
    apiKey: string;
    responseModel: string;
    /** OpenRouter only — used as the upstream model when `responseModel`
     *  is the `openrouter:custom` sentinel. */
    customResponseModelId?: string;
  };
  signal?: AbortSignal;
}

/** Callback supplied by the generator so `runGroup`/`runOne` can push
 *  observability events into the drain queue without needing to be generators
 *  themselves. The event is pushed synchronously; `wake()` is the caller's
 *  responsibility if it wants immediate delivery. */
type DebugCallback = (event: Extract<GenerateResponsesEvent, { type: "debug" }>) => void;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function* generateResponses(
  input: GenerateResponsesInput,
): AsyncGenerator<GenerateResponsesEvent, void, void> {
  const { personas, questions, surveyContext, credentials, signal } = input;
  const total = personas.length;
  yield { type: "start", total };

  if (total === 0) {
    yield { type: "complete", responses: [] };
    return;
  }

  const concurrency = getProviderConcurrency(
    credentials.provider,
    credentials.responseModel,
  );

  // Group personas into batches of RESPONSE_GROUP_SIZE to reduce LLM call count.
  const groups: Array<{ indices: number[]; personas: Persona[] }> = [];
  for (let i = 0; i < total; i += RESPONSE_GROUP_SIZE) {
    const slice = personas.slice(i, i + RESPONSE_GROUP_SIZE);
    groups.push({ indices: Array.from({ length: slice.length }, (_, k) => i + k), personas: slice });
  }

  // Event queue + wake promise — same pattern as persona-synthesizer.
  const eventQueue: GenerateResponsesEvent[] = [];
  let resolveWake: (() => void) | null = null;
  const wake = () => {
    if (resolveWake) {
      const r = resolveWake;
      resolveWake = null;
      r();
    }
  };
  const waitForWake = () =>
    new Promise<void>((resolve) => {
      resolveWake = resolve;
    });

  if (signal) {
    if (signal.aborted) {
      wake();
    } else {
      signal.addEventListener("abort", () => wake(), { once: true });
    }
  }

  const results: (GeneratedResponse | null)[] = new Array(total).fill(null);
  let completed = 0;
  let active = 0;
  let nextGroupIdx = 0;
  let allDone = false;

  // Debug callback: push observability events into the drain queue and
  // immediately wake the loop so they're delivered without waiting for
  // the next worker to settle.
  const onDebug: DebugCallback = (event) => {
    eventQueue.push(event);
    wake();
  };

  function maybeStartWorker(): void {
    while (active < concurrency && nextGroupIdx < groups.length && !signal?.aborted) {
      const group = groups[nextGroupIdx++]!;
      active += 1;
      runGroup(group.personas, questions, surveyContext, credentials, signal, onDebug)
        .then((groupResults) => {
          for (let k = 0; k < group.personas.length; k++) {
            const persona = group.personas[k]!;
            const r = groupResults[k]!;
            results[group.indices[k]!] = r.response;
            if (r.warning) {
              eventQueue.push({
                type: "persona_warning",
                personaId: persona.id,
                personaName: `${persona.firstName} ${persona.lastName}`,
                message: r.warning,
              });
            }
            // Emit the response itself BEFORE the progress tick so the
            // client can persist incrementally and the progress count
            // truthfully reflects items already in its store.
            eventQueue.push({ type: "response_completed", response: r.response });
            completed += 1;
            eventQueue.push({
              type: "progress",
              completed,
              total,
              latestPersonaName: `${persona.firstName} ${persona.lastName}`,
            });
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          for (let k = 0; k < group.personas.length; k++) {
            const persona = group.personas[k]!;
            const fallback = makeFallbackResponse(persona, questions);
            results[group.indices[k]!] = fallback;
            eventQueue.push({
              type: "persona_warning",
              personaId: persona.id,
              personaName: `${persona.firstName} ${persona.lastName}`,
              message: `Unexpected worker failure: ${msg}`,
            });
            // Persist the fallback response too so the user has SOMETHING
            // for that persona rather than a hole on resume.
            eventQueue.push({ type: "response_completed", response: fallback });
            completed += 1;
            eventQueue.push({
              type: "progress",
              completed,
              total,
              latestPersonaName: `${persona.firstName} ${persona.lastName}`,
            });
          }
        })
        .finally(() => {
          active -= 1;
          if (active === 0 && nextGroupIdx >= groups.length) {
            allDone = true;
          } else {
            maybeStartWorker();
          }
          wake();
        });
    }
  }

  maybeStartWorker();

  // Drain loop — yield events as they arrive, exit on abort or completion.
  while (!allDone || eventQueue.length > 0) {
    if (signal?.aborted) {
      yield { type: "error", message: "Aborted by user." };
      return;
    }
    if (eventQueue.length > 0) {
      yield eventQueue.shift()!;
      continue;
    }
    await waitForWake();
  }

  // Assemble the final ordered list. Any null slots (shouldn't happen, but
  // defensive) get fallback responses to keep the array length stable.
  const finalResponses: GeneratedResponse[] = results.map((r, i) =>
    r ?? makeFallbackResponse(personas[i]!, questions),
  );
  yield { type: "complete", responses: finalResponses };
}

// ---------------------------------------------------------------------------
// Group execution — calls the LLM once for N personas, then validates each
// result individually. Falls back to single-persona calls if the batch
// response is malformed.
// ---------------------------------------------------------------------------

interface RunResult {
  response: GeneratedResponse;
  warning?: string;
}

async function runGroup(
  personas: Persona[],
  questions: Question[],
  surveyContext: SurveyContext,
  credentials: GenerateResponsesInput["credentials"],
  signal: AbortSignal | undefined,
  onDebug: DebugCallback,
): Promise<RunResult[]> {
  const groupLabel = personas.map((p) => `${p.firstName} ${p.lastName}`).join(", ");
  const startedAt = Date.now();
  onDebug({ type: "debug", kind: "worker_start", label: groupLabel });

  // Single-persona group — just call the existing single-persona path.
  if (personas.length === 1) {
    const result = await runOne(personas[0]!, questions, surveyContext, credentials, signal, onDebug);
    onDebug({ type: "debug", kind: "worker_done", label: groupLabel, latencyMs: Date.now() - startedAt });
    return [result];
  }

  let retryReason: string | undefined;
  let rateLimitRetries = 0;
  let validationAttempts = 0;

  while (validationAttempts <= MAX_RETRIES) {
    if (signal?.aborted) {
      onDebug({ type: "debug", kind: "worker_fail", label: groupLabel });
      return personas.map((p) => ({ response: makeFallbackResponse(p, questions), warning: "Aborted." }));
    }

    const prompt = buildBatchResponsePrompt({ personas, questions, surveyContext, retryReason });

    const llm = await callLLMForJson({
      provider: credentials.provider,
      apiKey: credentials.apiKey,
      model: credentials.responseModel,
      upstreamModelId: resolveUpstreamModel(credentials),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: MAX_BATCH_OUTPUT_TOKENS,
      signal,
    });

    // Rate-limit: exponential back-off, independent of validation budget.
    // Sequence: 1s → 2s → 4s → 8s → 8s (jitter ±25%).
    if (!llm.ok && llm.rateLimited) {
      if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) break;
      const expBase = MIN_RATE_LIMIT_BACKOFF_MS * Math.pow(2, rateLimitRetries);
      const baseMs = llm.retryAfterMs
        ? Math.max(MIN_RATE_LIMIT_BACKOFF_MS, llm.retryAfterMs)
        : Math.min(DEFAULT_RATE_LIMIT_BACKOFF_MS, expBase);
      const jitterMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));
      rateLimitRetries += 1;
      onDebug({ type: "debug", kind: "rate_limit", label: groupLabel, backoffMs: jitterMs });
      await sleepWithAbort(jitterMs, signal);
      if (signal?.aborted) break;
      continue;
    }

    if (!llm.ok) {
      retryReason = llm.error ?? `HTTP ${llm.status}`;
      onDebug({ type: "debug", kind: "retry", label: `${groupLabel} — ${retryReason}` });
      validationAttempts += 1;
      continue;
    }

    // Unwrap array — handle both bare array and { responses: [...] } envelope.
    let arr: unknown[];
    const parsed = llm.json;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).responses)) {
      arr = (parsed as Record<string, unknown>).responses as unknown[];
    } else {
      retryReason = `Expected JSON array of ${personas.length} objects, got ${typeof parsed}`;
      validationAttempts += 1;
      continue;
    }

    if (arr.length !== personas.length) {
      retryReason = `Expected ${personas.length} responses in array, got ${arr.length}`;
      validationAttempts += 1;
      continue;
    }

    // Validate each persona's element individually.
    const out: RunResult[] = [];
    const errors: string[] = [];
    for (let i = 0; i < personas.length; i++) {
      const persona = personas[i]!;
      const validation = validateResponseOutput({
        parsed: arr[i],
        persona,
        questions,
        expectedQuestionIds: prompt.expectedQuestionIds,
        expectedAnswerTypes: prompt.expectedAnswerTypes,
      });
      if (validation.ok) {
        out.push({ response: makeResponse(persona, validation.answers) });
      } else {
        errors.push(`Persona ${i + 1} (${persona.firstName}): ${summarizeResponseValidationErrors(validation.errors)}`);
        out.push({ response: makeResponse(persona, validation.answers), warning: summarizeResponseValidationErrors(validation.errors) });
      }
    }

    if (errors.length === 0) {
      onDebug({ type: "debug", kind: "worker_done", label: groupLabel, latencyMs: Date.now() - startedAt });
      return out;
    }

    // Some personas failed — retry the whole batch with error context.
    retryReason = errors.join(" | ");
    validationAttempts += 1;
    // Keep out as the best-partial for fallback if retries exhaust.
    if (validationAttempts > MAX_RETRIES) {
      onDebug({ type: "debug", kind: "worker_done", label: groupLabel, latencyMs: Date.now() - startedAt });
      return out;
    }
  }

  // Retries exhausted — fall back to individual calls for each persona.
  const fallback = await Promise.all(
    personas.map((p) => runOne(p, questions, surveyContext, credentials, signal, onDebug)),
  );
  onDebug({ type: "debug", kind: "worker_done", label: groupLabel, latencyMs: Date.now() - startedAt });
  return fallback;
}

// ---------------------------------------------------------------------------
// Single-persona execution with retries
// ---------------------------------------------------------------------------

async function runOne(
  persona: Persona,
  questions: Question[],
  surveyContext: SurveyContext,
  credentials: GenerateResponsesInput["credentials"],
  signal: AbortSignal | undefined,
  onDebug: DebugCallback,
): Promise<RunResult> {
  const label = `${persona.firstName} ${persona.lastName}`;
  let retryReason: string | undefined;
  let lastError: string | undefined;
  let bestPartial: Record<string, AnswerValue> | null = null;
  let rateLimitRetries = 0;
  let validationAttempts = 0;

  // Hybrid retry loop: rate-limit retries don't consume the validation
  // budget. The two are budgeted independently so a persona that hits a
  // 429 followed by a validation failure still gets the configured number
  // of validation attempts.
  while (validationAttempts <= MAX_RETRIES) {
    if (signal?.aborted) {
      lastError = "Aborted before completion.";
      break;
    }

    const prompt = buildResponsePrompt({
      persona,
      questions,
      surveyContext,
      retryReason,
    });

    // Soft pre-flight check on input tokens. The prompt builder already
    // produced the rendered string — we estimate cheaply rather than
    // calling tokenize libs. If we're over budget, surface a warning but
    // still attempt.
    const approxTokens = Math.ceil(
      (prompt.systemPrompt.length + prompt.userPrompt.length) / 4,
    );
    if (approxTokens > SOFT_INPUT_TOKEN_BUDGET && validationAttempts === 0) {
      retryReason = `(prompt is ~${approxTokens} tokens; consider splitting the survey if this fails)`;
    }

    const llm = await callLLMForJson({
      provider: credentials.provider,
      apiKey: credentials.apiKey,
      model: credentials.responseModel,
      upstreamModelId: resolveUpstreamModel(credentials),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal,
    });

    // Rate-limit: exponential back-off (1s → 2s → 4s → 8s → 8s, ±25%
    // jitter). Budget is independent of validation attempts.
    if (!llm.ok && llm.rateLimited) {
      if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
        lastError = llm.error ?? "Rate limit retries exhausted.";
        break;
      }
      const expBase = MIN_RATE_LIMIT_BACKOFF_MS * Math.pow(2, rateLimitRetries);
      const baseMs = llm.retryAfterMs
        ? Math.max(MIN_RATE_LIMIT_BACKOFF_MS, llm.retryAfterMs)
        : Math.min(DEFAULT_RATE_LIMIT_BACKOFF_MS, expBase);
      const jitterMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));
      rateLimitRetries += 1;
      onDebug({ type: "debug", kind: "rate_limit", label, backoffMs: jitterMs });
      await sleepWithAbort(jitterMs, signal);
      if (signal?.aborted) {
        lastError = "Aborted during rate-limit backoff.";
        break;
      }
      continue;
    }

    if (!llm.ok) {
      lastError = llm.error ?? `HTTP ${llm.status}`;
      retryReason = lastError;
      onDebug({ type: "debug", kind: "retry", label: `${label} — ${retryReason}` });
      validationAttempts += 1;
      continue;
    }

    const validation = validateResponseOutput({
      parsed: llm.json,
      persona,
      questions,
      expectedQuestionIds: prompt.expectedQuestionIds,
      expectedAnswerTypes: prompt.expectedAnswerTypes,
    });

    if (validation.ok) {
      return { response: makeResponse(persona, validation.answers) };
    }

    // Track best partial answer set so we have something to return if
    // retries exhaust. "Best" = most populated.
    if (
      !bestPartial ||
      Object.keys(validation.answers).length > Object.keys(bestPartial).length
    ) {
      bestPartial = validation.answers;
    }

    retryReason = summarizeResponseValidationErrors(validation.errors);
    lastError = retryReason;
    validationAttempts += 1;
  }

  // All retries exhausted — fall back to the best partial we have.
  const answers = bestPartial ?? {};
  return {
    response: makeResponse(persona, answers),
    warning: lastError ? `Used best-effort answers after retries: ${lastError}` : undefined,
  };
}

/**
 * Sleep that resolves early on abort. Used by the rate-limit backoff so a
 * Cancel click during a long Retry-After wait responds immediately instead
 * of stalling for the full window.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the upstream model ID for the LLM call. For OpenRouter custom
 *  sentinel models, returns the user-supplied custom ID; otherwise undefined
 *  so the dispatcher uses the registry's model field directly. */
function resolveUpstreamModel(
  credentials: GenerateResponsesInput["credentials"],
): string | undefined {
  if (credentials.responseModel === "openrouter:custom") {
    return credentials.customResponseModelId;
  }
  return undefined;
}

function makeResponse(
  persona: Persona,
  answers: Record<string, AnswerValue>,
): GeneratedResponse {
  return {
    id: makeUuid(),
    personaId: persona.id,
    personaName: `${persona.firstName} ${persona.lastName}`,
    answers,
    generatedAt: Date.now(),
    status: "generated",
  };
}

function makeFallbackResponse(
  persona: Persona,
  questions: Question[],
): GeneratedResponse {
  // Empty answers map. The orchestrator will have surfaced a warning for
  // this persona by the time the fallback is used; the preview will show
  // the persona row with an empty answers expansion, and 5c's push will
  // handle (or skip) it.
  void questions;
  return makeResponse(persona, {});
}

// Cheap UUID v4-ish — avoids pulling in a uuid lib for one place.
function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes — Math.random is fine for non-secret IDs.
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, "0");
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

// Re-export the AnswerType so callers don't need a separate import path.
export type { AnswerType };
