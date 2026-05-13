"use client";

import { useResponsesStore, hashGenerationInputs } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { useSurveyStore } from "@/store/survey-store";
import { useSetupStore } from "@/store/setup-store";
import { partitionQuestionsForGeneration } from "@/lib/surveysparrow/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { GenerateResponsesHookState } from "./useGenerateResponses";

// Phase 7a — shown on the Generate step when sessionStorage holds a
// partially-generated set of responses from a run that was interrupted,
// errored, or cancelled. Three actions:
//   - Resume: continues the run, regenerating only the personas that
//     don't yet have a stored response. Existing responses are preserved.
//   - Use partial: marks the partial set as final and proceeds to the
//     preview / push flow with whatever was already generated.
//   - Discard: wipes the stored responses and returns to pre-generation.
//
// CRITICAL: never silently discards data. The user explicitly chooses.

interface Props {
  gen: GenerateResponsesHookState;
}

export function RecoveryCard({ gen }: Props) {
  const status = useResponsesStore((s) => s.status);
  const error = useResponsesStore((s) => s.error);
  const responses = useResponsesStore((s) => s.responses);
  const finishRun = useResponsesStore((s) => s.finishRun);
  const reset = useResponsesStore((s) => s.reset);

  const personas = usePersonasStore((s) => s.personas);
  const personasHash = usePersonasStore((s) => s.sourceConfigHash);

  const questionsData = useSurveyStore((s) => s.questions.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const responseModel = useSetupStore((s) => s.llm.responseModel);

  const partialCount = responses.length;
  const totalCount = personas.length;
  const { pendingCount } = gen;
  const canResume = pendingCount > 0;

  const headline =
    status === "interrupted"
      ? "Last run was interrupted"
      : status === "aborted"
        ? "Last run was cancelled"
        : "Last run failed";
  const Icon = status === "aborted" ? XCircle : AlertCircle;
  const variant: "warning" | "destructive" =
    status === "error" ? "destructive" : "warning";

  function handleUsePartial() {
    // Flip status to "complete" so the preview / push UI takes over.
    const answerableQuestions = questionsData
      ? partitionQuestionsForGeneration(questionsData).kept
      : [];
    const hash = hashGenerationInputs({
      personasHash: personasHash ?? "x",
      questionCount: answerableQuestions.length,
      responseModelId: responseModel,
      surveyId: selectedSurveyId,
    });
    finishRun(responses, hash);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon
            className={
              status === "error"
                ? "h-5 w-5 text-destructive"
                : "h-5 w-5 text-amber-500"
            }
          />
          <CardTitle>{headline}</CardTitle>
        </div>
        <CardDescription>
          {totalCount > 0
            ? `${partialCount.toLocaleString()} of ${totalCount.toLocaleString()} responses were generated and saved before the run stopped.`
            : `${partialCount.toLocaleString()} responses were generated and saved before the run stopped.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant={variant}>
            <AlertDescription className="flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </AlertDescription>
          </Alert>
        )}

        {/* Partial summary block */}
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-3">
          <Stat
            label="Saved"
            value={partialCount.toLocaleString()}
            tone="success"
          />
          <Stat
            label="Pending"
            value={pendingCount.toLocaleString()}
            tone={pendingCount > 0 ? "warning" : "muted"}
          />
          <Stat
            label="Total"
            value={totalCount.toLocaleString()}
            tone="muted"
          />
        </div>

        {!canResume && partialCount > 0 && (
          <Alert>
            <AlertDescription className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
              All personas already have a saved response — nothing to resume.
              Use the partial set to continue.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {canResume && (
            <Button size="lg" onClick={() => void gen.resume()} className="gap-2">
              <Play className="h-4 w-4" />
              Resume ({pendingCount.toLocaleString()} pending)
            </Button>
          )}
          {partialCount > 0 && (
            <Button
              size="lg"
              variant={canResume ? "outline" : "default"}
              onClick={handleUsePartial}
              className="gap-2"
            >
              <Eye className="h-4 w-4" />
              Use partial set ({partialCount.toLocaleString()})
            </Button>
          )}
          <Button
            size="lg"
            variant="ghost"
            onClick={() => reset()}
            className="gap-2 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Discard
          </Button>
        </div>

        {pendingCount > 0 && partialCount > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Resume re-runs only the {pendingCount.toLocaleString()} pending personas.
            Already-saved responses are preserved.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small atoms
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "muted";
}) {
  const valueClass =
    tone === "success"
      ? "text-green-600 dark:text-green-400"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={`text-base font-semibold tabular-nums ${valueClass}`}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Companion: re-export the icon used elsewhere
// ---------------------------------------------------------------------------

export { RefreshCw };
