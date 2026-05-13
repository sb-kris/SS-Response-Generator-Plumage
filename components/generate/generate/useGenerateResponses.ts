"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { usePersonasStore } from "@/store/personas-store";
import { useResponsesStore, hashGenerationInputs } from "@/store/responses-store";
import { streamResponseGeneration } from "@/lib/generation/sse-responses-client";
import {
  estimateCost,
  type CostEstimate,
} from "@/lib/generation/cost-estimator";
import { partitionQuestionsForGeneration } from "@/lib/surveysparrow/types";
import type { SurveyContext } from "@/lib/llm/prompts/response-prompt";

// Hook that owns the lifecycle of a Phase 5a response-generation run.
//
// CRITICAL: this hook MUST be called once at the parent (`GenerateAndPushStep`)
// and the resulting state passed down to child cards as a prop. The Phase 4
// "instant cancel" bug came from each card calling its own `useSynthesize` —
// when the card swapped on state change, the unmounting card's cleanup
// effect aborted its own AbortController, killing the run. Don't make the
// same mistake here.
//
// Phase 7a: per-response events arrive via SSE `response_completed` and are
// pushed into the responses store immediately. The final `complete` event
// reconciles by replacing the array (catches any incremental events lost
// to network blips). `resume()` continues an interrupted run by sending
// only the personas that don't yet have a stored response.

export interface GenerateResponsesHookState {
  start: () => Promise<void>;
  /** Continue an interrupted run — sends only the not-yet-generated personas. */
  resume: () => Promise<void>;
  cancel: () => void;
  canStart: boolean;
  reasonNotReady: string | null;
  estimatedSeconds: number | null;
  estimate: CostEstimate | null;
  /** Personas that haven't yet been generated for. Drives the recovery UI. */
  pendingCount: number;
}

export function useGenerateResponses(): GenerateResponsesHookState {
  const setupLLM = useSetupStore((s) => s.llm);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questions = useSurveyStore((s) => s.questions.data);
  const personas = usePersonasStore((s) => s.personas);
  const personasStatus = usePersonasStore((s) => s.status);
  const sourceConfigHash = usePersonasStore((s) => s.sourceConfigHash);
  const draft = useGenerationStore((s) => s.draft);
  const existingResponses = useResponsesStore((s) => s.responses);

  const startRunStore = useResponsesStore((s) => s.startRun);
  const resumeRunStore = useResponsesStore((s) => s.resumeRun);
  const reportProgress = useResponsesStore((s) => s.reportProgress);
  const reportPersonaWarning = useResponsesStore((s) => s.reportPersonaWarning);
  const appendResponse = useResponsesStore((s) => s.appendResponse);
  const finishRun = useResponsesStore((s) => s.finishRun);
  const failRun = useResponsesStore((s) => s.failRun);
  const abortRun = useResponsesStore((s) => s.abortRun);
  const appendDebugLog = useResponsesStore((s) => s.appendDebugLog);

  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight run if the component unmounts (route change, sign-out).
  // Sign-out also calls `reset()` on the store directly via LogoutButton.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Reduce questions to the answerable subset — this drives the count shown
  // in the pre-generation card and the cost estimate.
  const answerableQuestions = (() => {
    if (!questions) return null;
    const { kept } = partitionQuestionsForGeneration(questions);
    return kept;
  })();
  const answerableQuestionCount = answerableQuestions?.length ?? 0;

  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;
  const englishWeight =
    draft.languageDistribution.find((l) => l.code === "en")?.weight ?? 100;
  const nonEnglishFraction = Math.max(0, Math.min(1, (100 - englishWeight) / 100));

  const estimate = estimateCost({
    responseCount: personas.length,
    questionCount: answerableQuestionCount,
    personaModelId: setupLLM.personaModel,
    responseModelId: setupLLM.responseModel,
    nonEnglishFraction,
  });
  const responseEstimate: CostEstimate | null = estimate
    ? {
        ...estimate,
        totalCost: estimate.response.cost,
        totalSeconds: estimate.totalSeconds - estimate.persona.totalTokens / 50_000,
      }
    : null;
  const estimatedSeconds = responseEstimate?.totalSeconds ?? null;

  const reasonNotReady = computeReasonNotReady({
    apiKey: setupLLM.apiKey,
    personasStatus,
    personasCount: personas.length,
    questionCount: answerableQuestionCount,
    selectedSurveyId,
  });
  const canStart = reasonNotReady === null;

  // Personas not yet generated for — used by recovery UI and resume().
  const pendingPersonas = personas.filter(
    (p) => !existingResponses.some((r) => r.personaId === p.id),
  );
  const pendingCount = pendingPersonas.length;

  // Internal worker — shared by start() and resume().
  const runStream = useCallback(
    async (
      personasToProcess: typeof personas,
      mode: "fresh" | "resume",
      offsetCompleted: number,
      overallTotal: number,
    ) => {
      if (!selectedSurvey) {
        failRun("No survey selected.");
        return;
      }
      if (!answerableQuestions || answerableQuestions.length === 0) {
        failRun("No answerable questions in this survey.");
        return;
      }
      if (personasToProcess.length === 0) {
        // Nothing to do — caller should have guarded.
        return;
      }

      const surveyContext: SurveyContext = {
        surveyName: selectedSurvey.name,
        useCase: draft.useCase,
        themes: draft.themes,
      };

      if (mode === "fresh") {
        startRunStore(personasToProcess.length, estimatedSeconds);
        // startRun clears debugLog — add a run-boundary marker after.
        appendDebugLog({ time: Date.now(), kind: "info", label: `Run started — ${personasToProcess.length} personas` });
      } else {
        // Show overall progress from the start (e.g. "22 / 50") so it's
        // obvious we're continuing, not restarting.
        resumeRunStore(offsetCompleted, overallTotal, estimatedSeconds);
        appendDebugLog({ time: Date.now(), kind: "info", label: `Run resumed — ${personasToProcess.length} pending` });
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const result = await streamResponseGeneration({
        body: {
          personas: personasToProcess,
          questions: answerableQuestions,
          surveyContext,
          credentials: {
            provider: setupLLM.provider,
            apiKey: setupLLM.apiKey,
            responseModel: setupLLM.responseModel,
            // OpenRouter-only; ignored by the route for other providers.
            customResponseModelId:
              setupLLM.responseModel === "openrouter:custom"
                ? setupLLM.customResponseModelId
                : undefined,
          },
        },
        signal: ctrl.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "progress":
              // Translate segment-relative progress into overall progress
              // when resuming so the UI never appears to "go backwards".
              reportProgress({
                completed: offsetCompleted + event.completed,
                total: overallTotal,
                latestPersonaName: event.latestPersonaName,
              });
              break;
            case "persona_warning":
              reportPersonaWarning(event.personaName, event.message);
              break;
            case "response_completed":
              // Stream into the store as soon as it lands — this is the
              // crux of partial-progress recovery.
              appendResponse(event.response);
              break;
            case "complete": {
              const hash = hashGenerationInputs({
                personasHash: sourceConfigHash ?? "x",
                questionCount: answerableQuestions.length,
                responseModelId: setupLLM.responseModel,
                surveyId: selectedSurveyId,
              });
              if (mode === "resume") {
                // In resume mode, the server's `complete.responses` only
                // contains the segment we asked for. Merge with what's
                // already in store rather than replacing.
                const segmentResponses = event.responses;
                const inStore = useResponsesStore.getState().responses;
                const byId = new Map(inStore.map((r) => [r.id, r] as const));
                for (const r of segmentResponses) byId.set(r.id, r);
                finishRun(Array.from(byId.values()), hash);
              } else {
                finishRun(event.responses, hash);
              }
              break;
            }
            case "error":
              failRun(event.message);
              break;
            case "debug":
              appendDebugLog({
                time: Date.now(),
                kind: event.kind,
                label: event.label,
                latencyMs: event.latencyMs,
                backoffMs: event.backoffMs,
              });
              break;
            default:
              break;
          }
        },
      });

      abortRef.current = null;
      if (!result.ok) {
        if (ctrl.signal.aborted) {
          abortRun();
        } else {
          failRun(result.error ?? `Generation failed (HTTP ${result.status}).`);
        }
      }
    },
    [
      abortRun,
      answerableQuestions,
      appendDebugLog,
      appendResponse,
      draft.themes,
      draft.useCase,
      estimatedSeconds,
      failRun,
      finishRun,
      reportProgress,
      reportPersonaWarning,
      resumeRunStore,
      selectedSurvey,
      selectedSurveyId,
      setupLLM.apiKey,
      setupLLM.provider,
      setupLLM.responseModel,
      setupLLM.customResponseModelId,
      sourceConfigHash,
      startRunStore,
    ],
  );

  const start = useCallback(async () => {
    if (personas.length === 0) {
      failRun("No personas synthesized — go back to step 3.");
      return;
    }
    await runStream(personas, "fresh", 0, personas.length);
  }, [failRun, personas, runStream]);

  const resume = useCallback(async () => {
    if (pendingPersonas.length === 0) {
      // Nothing to resume — flip status to complete so the UI moves on.
      const hash = hashGenerationInputs({
        personasHash: sourceConfigHash ?? "x",
        questionCount: answerableQuestionCount,
        responseModelId: setupLLM.responseModel,
        surveyId: selectedSurveyId,
      });
      finishRun(useResponsesStore.getState().responses, hash);
      return;
    }
    const offset = personas.length - pendingPersonas.length;
    await runStream(pendingPersonas, "resume", offset, personas.length);
  }, [
    answerableQuestionCount,
    finishRun,
    pendingPersonas,
    personas.length,
    runStream,
    selectedSurveyId,
    setupLLM.responseModel,
    sourceConfigHash,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    start,
    resume,
    cancel,
    canStart,
    reasonNotReady,
    estimatedSeconds,
    estimate: responseEstimate,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// Reason-not-ready computation
// ---------------------------------------------------------------------------

function computeReasonNotReady(input: {
  apiKey: string;
  personasStatus: string;
  personasCount: number;
  questionCount: number;
  selectedSurveyId: number | null;
}): string | null {
  if (!input.apiKey) {
    return "Your LLM API key isn't in memory. Refreshing the page clears it — go back to Setup and re-test the connection.";
  }
  if (input.selectedSurveyId === null) {
    return "No survey selected. Pick one in step 1 first.";
  }
  if (input.personasStatus !== "complete" || input.personasCount === 0) {
    return "Synthesize personas first (step 3).";
  }
  if (input.questionCount === 0) {
    return "This survey has no answerable questions for Plumage to generate.";
  }
  return null;
}
