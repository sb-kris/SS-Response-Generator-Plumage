"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { hashSynthesisInputs, usePersonasStore } from "@/store/personas-store";
import { streamPersonaSynthesis } from "@/lib/generation/sse-client";
import {
  estimateCost,
  type CostEstimate,
} from "@/lib/generation/cost-estimator";
import { partitionQuestionsForGeneration } from "@/lib/surveysparrow/types";
import type { SurveyContext } from "@/lib/llm/prompts/persona-prompt";
import type { Persona } from "@/lib/generation/persona-types";

// Hook that owns the lifecycle of a Phase 4 synthesis run. The component
// reads progress / personas / status from `usePersonasStore` directly;
// this hook just exposes `start` and `cancel` callbacks plus a derived
// `canStart` flag.

export interface SynthesizeHookState {
  start: () => Promise<void>;
  cancel: () => void;
  canStart: boolean;
  reasonNotReady: string | null;
  estimatedSeconds: number | null;
  estimate: CostEstimate | null;
}

export function useSynthesize(): SynthesizeHookState {
  const setupLLM = useSetupStore((s) => s.llm);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questions = useSurveyStore((s) => s.questions.data);
  const draft = useGenerationStore((s) => s.draft);

  const startRun = usePersonasStore((s) => s.startRun);
  const reportProgress = usePersonasStore((s) => s.reportProgress);
  const reportWarning = usePersonasStore((s) => s.reportWarning);
  const appendPersonas = usePersonasStore((s) => s.appendPersonas);
  const finishRun = usePersonasStore((s) => s.finishRun);
  const failRun = usePersonasStore((s) => s.failRun);
  const abortRun = usePersonasStore((s) => s.abortRun);

  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight run if the component unmounts (route change, sign-out).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;
  const responseCount = draft.timeRange.responseCount;
  const questionCount = (() => {
    if (!questions) return 0;
    return partitionQuestionsForGeneration(questions).kept.length;
  })();
  const englishWeight =
    draft.languageDistribution.find((l) => l.code === "en")?.weight ?? 100;
  const nonEnglishFraction = Math.max(0, Math.min(1, (100 - englishWeight) / 100));

  const estimate = estimateCost({
    responseCount,
    questionCount,
    personaModelId: setupLLM.personaModel,
    responseModelId: setupLLM.responseModel,
    nonEnglishFraction,
  });
  // Persona-synthesis-only ETA uses per-call generation speed, not aggregate
  // throughput. The cost estimator's totalSeconds is the full pipeline and its
  // speed constants model batch throughput, so it gives ~0s for synthesis alone.
  const estimatedSeconds = estimatePersonaSynthesisSeconds(
    responseCount,
    setupLLM.personaModel,
  );

  const reasonNotReady = computeReasonNotReady({
    apiKey: setupLLM.apiKey,
    selectedSurveyId,
    responseCount,
  });
  const canStart = reasonNotReady === null;

  const start = useCallback(async () => {
    if (!selectedSurvey) {
      failRun("No survey selected.");
      return;
    }
    const surveyContext: SurveyContext = {
      surveyName: selectedSurvey.name,
      useCase: draft.useCase,
      themes: draft.themes,
    };

    const totalBatches = Math.ceil(responseCount / 10); // must match BATCH_SIZE in persona-synthesizer.ts
    startRun(totalBatches, responseCount, estimatedSeconds);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const collectedPersonas: Persona[] = [];

    const result = await streamPersonaSynthesis({
      body: {
        draft,
        responseCount,
        surveyContext,
        credentials: {
          provider: setupLLM.provider,
          apiKey: setupLLM.apiKey,
          personaModel: setupLLM.personaModel,
          // OpenRouter-only; ignored by the route for other providers.
          customPersonaModelId:
            setupLLM.personaModel === "openrouter:custom"
              ? setupLLM.customPersonaModelId
              : undefined,
        },
      },
      signal: ctrl.signal,
      onEvent: (event) => {
        switch (event.type) {
          case "progress":
            reportProgress({
              completed: event.completed,
              total: event.total,
              currentBatch: event.currentBatch,
            });
            break;
          case "batch_warning":
            reportWarning(event.message);
            break;
          case "personas_enriched":
            // Stream this batch's personas into the store as soon as they
            // land. Survives tab close / network failure.
            appendPersonas(event.personas);
            break;
          case "complete": {
            const hash = hashSynthesisInputs({
              responseCount,
              surveyId: selectedSurveyId,
              draftJson: JSON.stringify(draft),
            });
            finishRun(event.personas, hash);
            collectedPersonas.push(...event.personas);
            break;
          }
          case "error":
            failRun(event.message);
            break;
          // `start` event has no UI consequence — totals are already known.
          default:
            break;
        }
      },
    });

    abortRef.current = null;
    if (!result.ok) {
      // Distinguish user-initiated cancel from a real failure so the UI can
      // show the "cancelled" state instead of an error toast.
      if (ctrl.signal.aborted) {
        abortRun();
      } else {
        failRun(result.error ?? `Synthesis failed (HTTP ${result.status}).`);
      }
    }
  }, [
    abortRun,
    appendPersonas,
    draft,
    estimatedSeconds,
    failRun,
    finishRun,
    reportProgress,
    reportWarning,
    responseCount,
    selectedSurvey,
    selectedSurveyId,
    setupLLM.apiKey,
    setupLLM.personaModel,
    setupLLM.customPersonaModelId,
    setupLLM.provider,
    startRun,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { start, cancel, canStart, reasonNotReady, estimatedSeconds, estimate };
}

// ---------------------------------------------------------------------------
// Reason-not-ready computation
// ---------------------------------------------------------------------------

function computeReasonNotReady(input: {
  apiKey: string;
  selectedSurveyId: number | null;
  responseCount: number;
}): string | null {
  if (!input.apiKey) {
    return "Your LLM API key isn't in memory. Refreshing the page clears it — go back to Setup and re-test the connection.";
  }
  if (input.selectedSurveyId === null) {
    return "No survey selected. Pick one in step 1 first.";
  }
  if (input.responseCount < 1) {
    return "Set the number of responses to at least 1 in the Configure step.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persona-synthesis timing estimate
// ---------------------------------------------------------------------------

// Per-request output tokens/second for a single LLM call (not aggregate
// throughput — output is sequential within a request).
const PERSONA_CALL_TPS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 80,
  "claude-sonnet-4-6": 35,
  "claude-opus-4-7": 15,
  "gpt-4o-mini": 60,
  "gpt-4o": 25,
};

// Must match BATCH_SIZE and CONCURRENCY in persona-synthesizer.ts.
const SYNTH_BATCH_SIZE = 10;
const SYNTH_CONCURRENCY = 3;

function estimatePersonaSynthesisSeconds(
  responseCount: number,
  personaModelId: string,
): number {
  const tps = PERSONA_CALL_TPS[personaModelId] ?? 35;
  const batches = Math.ceil(responseCount / SYNTH_BATCH_SIZE);
  const rounds = Math.ceil(batches / SYNTH_CONCURRENCY);
  // ~800 input + 10×120 output = 2000 tokens per batch, +30% overhead.
  const tokensPerBatch = 800 + SYNTH_BATCH_SIZE * 4 + SYNTH_BATCH_SIZE * 120;
  return Math.ceil(rounds * (tokensPerBatch / tps) * 1.3);
}
