// Phase 4 orchestrator: ties the Faker layer, prompt builder, LLM call,
// and validator together into a single streaming pipeline.
//
// Design notes:
//   - Batches of 50 personas per LLM call (cheap + fits in 8k output tokens).
//   - Up to 3 batches in flight in parallel (`CONCURRENCY`). For a 200-persona
//     run that's 4 batches → 2 round-trips.
//   - Each batch retries up to 2 times on schema violation. The retry prompt
//     includes the specific validation error for the model to fix.
//   - Partial failure is acceptable: a batch that exhausts retries falls
//     back to the seed personas as-is (with default concerns/notes).
//   - Progress is reported via an async generator so the API route can
//     stream SSE events as work completes.
//
// SECURITY: all LLM credentials are passed in as arguments and never
// logged or persisted.

import { getProviderConcurrency, type LLMProvider } from "@/lib/llm/models";
import type { ProfileDraft } from "@/lib/profiles/types";
import type {
  Persona,
  PersonaLLMOutput,
  SentimentArchetype,
} from "./persona-types";
import { buildPersonaSeeds } from "./faker-layer";
import {
  buildPersonaPrompt,
  type SurveyContext,
} from "@/lib/llm/prompts/persona-prompt";
import { callLLMForJson } from "@/lib/llm/json-call";
import {
  summarizeValidationErrors,
  validatePersonaOutput,
} from "@/lib/llm/persona-validator";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// 10 personas per LLM call (was 50). Smaller batches complete faster,
// so the drain loop yields progress events every ~30–90 s rather than
// waiting for a single 10-minute mega-call. Quality is unaffected —
// the model enriches each persona independently of batch size.
const BATCH_SIZE = 10;
// Persona synthesis is short and the LLM call is the bottleneck; we cap
// at 3 parallel batches regardless of what the provider's response-phase
// concurrency would be. Empirically anything higher just triggers rate
// limits without speeding up the run noticeably.
const PERSONA_PHASE_MAX_CONCURRENCY = 3;
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesizeInput {
  draft: ProfileDraft;
  responseCount: number;
  surveyContext: SurveyContext;
  credentials: {
    provider: LLMProvider;
    apiKey: string;
    personaModel: string;
    /** OpenRouter only — used as the upstream model when `personaModel`
     *  is the `openrouter:custom` sentinel. */
    customPersonaModelId?: string;
  };
  /** Pass an AbortSignal to cancel the in-flight run. */
  signal?: AbortSignal;
}

export type SynthesizeEvent =
  | { type: "start"; total: number; batches: number }
  | { type: "progress"; completed: number; total: number; currentBatch: number }
  | { type: "batch_warning"; batchIndex: number; message: string }
  /** Emitted as soon as a batch finishes (success OR fallback to defaults).
   *  Carries the enriched personas for that batch. The client appends
   *  these to the personas store immediately so partial work survives
   *  tab close / network failure. The final `complete` event still
   *  carries the full array for reconciliation. */
  | { type: "personas_enriched"; batchIndex: number; personas: Persona[] }
  | { type: "complete"; personas: Persona[] }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Public entry point — async generator yielding stream events
// ---------------------------------------------------------------------------

export async function* synthesizePersonas(
  input: SynthesizeInput,
): AsyncGenerator<SynthesizeEvent, void, void> {
  const { draft, responseCount, surveyContext, credentials, signal } = input;

  // 1) Build the deterministic skeleton (Faker layer). Cheap; sync.
  let seeds: Persona[];
  try {
    seeds = buildPersonaSeeds(draft, responseCount);
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to build persona seeds",
    };
    return;
  }

  // 2) Slice into batches.
  const batches: Persona[][] = [];
  for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
    batches.push(seeds.slice(i, i + BATCH_SIZE));
  }
  yield { type: "start", total: seeds.length, batches: batches.length };

  // Concurrency: clamp the provider's default by the persona-phase ceiling.
  // Most providers' defaults are higher than 3, which is fine for response
  // generation but pointlessly aggressive for the short persona phase.
  const concurrency = Math.min(
    PERSONA_PHASE_MAX_CONCURRENCY,
    getProviderConcurrency(credentials.provider, credentials.personaModel),
  );

  // 3) Bounded-concurrency pool. We use an event queue + a Promise-based
  //    "wake up" signal so the generator can yield events as soon as any
  //    worker produces them (rather than only when ALL workers settle).
  const eventQueue: SynthesizeEvent[] = [];
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

  // If the request is aborted while we're waiting for a worker, wake the
  // drain loop immediately so it can exit instead of stalling until a
  // long-running fetch finally settles.
  if (signal) {
    if (signal.aborted) {
      wake();
    } else {
      signal.addEventListener("abort", () => wake(), { once: true });
    }
  }

  let completedPersonas = 0;
  let active = 0;
  let nextBatchIdx = 0;
  let allDone = false;

  function maybeStartWorker(): void {
    while (active < concurrency && nextBatchIdx < batches.length) {
      const batchIndex = nextBatchIdx++;
      const batch = batches[batchIndex]!;
      active += 1;
      runBatch(batch, draft, surveyContext, credentials, signal)
        .then((result) => {
          if (result.warning) {
            eventQueue.push({
              type: "batch_warning",
              batchIndex,
              message: result.warning,
            });
          }
          // Stream this batch's personas to the client BEFORE the progress
          // tick so the store is consistent with the count.
          eventQueue.push({
            type: "personas_enriched",
            batchIndex,
            personas: batch,
          });
          completedPersonas += batch.length;
          eventQueue.push({
            type: "progress",
            completed: completedPersonas,
            total: seeds.length,
            currentBatch: batchIndex + 1,
          });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          eventQueue.push({
            type: "batch_warning",
            batchIndex,
            message: `Unexpected batch failure: ${msg}`,
          });
          // Even on catch, ship the batch — these personas have at least
          // their Faker scaffolding and are usable, just without LLM enrichment.
          eventQueue.push({
            type: "personas_enriched",
            batchIndex,
            personas: batch,
          });
          completedPersonas += batch.length;
          eventQueue.push({
            type: "progress",
            completed: completedPersonas,
            total: seeds.length,
            currentBatch: batchIndex + 1,
          });
        })
        .finally(() => {
          active -= 1;
          if (active === 0 && nextBatchIdx >= batches.length) {
            allDone = true;
          } else {
            maybeStartWorker();
          }
          wake();
        });
    }
  }

  // Kick off the initial workers.
  maybeStartWorker();

  // Main drain loop — yield events as they arrive, cooperate with abort.
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

  yield { type: "complete", personas: seeds };
}

// ---------------------------------------------------------------------------
// Single-batch execution with retries
// ---------------------------------------------------------------------------

interface BatchResult {
  warning?: string;
}

async function runBatch(
  batch: Persona[],
  draft: ProfileDraft,
  surveyContext: SurveyContext,
  credentials: SynthesizeInput["credentials"],
  signal?: AbortSignal,
): Promise<BatchResult> {
  let lastError: string | undefined;
  let retryReason: string | undefined;
  const archetypes: SentimentArchetype[] = batch.map((p) => p.sentimentArchetype);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      lastError = "Aborted before completion.";
      break;
    }
    const prompt = buildPersonaPrompt({
      batch,
      draft,
      surveyContext,
      retryReason,
    });

    const llm = await callLLMForJson({
      provider: credentials.provider,
      apiKey: credentials.apiKey,
      model: credentials.personaModel,
      // OpenRouter-only: real upstream ID when personaModel is the sentinel.
      upstreamModelId:
        credentials.personaModel === "openrouter:custom"
          ? credentials.customPersonaModelId
          : undefined,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: 8_000,
      signal,
    });

    if (!llm.ok) {
      lastError = llm.error ?? `HTTP ${llm.status}`;
      retryReason = lastError;
      continue;
    }

    const validation = validatePersonaOutput(llm.json, batch.length, archetypes);
    if (validation.ok) {
      mergeIntoBatch(batch, validation.personas);
      return {};
    }

    // Invalid output — even though we have defaults, surface the issue and
    // try once more with the error in the prompt. Tentatively merge what we
    // got so we always have something usable if retries exhaust.
    retryReason = summarizeValidationErrors(validation.errors);
    mergeIntoBatch(batch, validation.personas);
    lastError = retryReason;
  }

  return {
    warning: lastError ? `Used defaults for some personas: ${lastError}` : undefined,
  };
}

function mergeIntoBatch(batch: Persona[], llmOutputs: PersonaLLMOutput[]): void {
  for (let i = 0; i < batch.length; i++) {
    const persona = batch[i]!;
    const out = llmOutputs[i];
    if (!out) continue;
    // Don't override the pre-assigned sentiment if the model drifted —
    // the persona distribution is authoritative.
    persona.keyConcerns = out.keyConcerns;
    persona.themesTouched = out.themesTouched;
    persona.verbosity = out.verbosity;
    persona.demographicNotes = out.demographicNotes;
  }
}
