"use client";

import { useGenerationStore } from "@/store/generation-store";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { usePersonasStore } from "@/store/personas-store";
import { useResponsesStore } from "@/store/responses-store";
import { partitionQuestionsForGeneration } from "@/lib/surveysparrow/types";
import { getModel } from "@/lib/llm/models";
import { formatMinutes, formatUsd } from "@/lib/generation/cost-estimator";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert, Sparkles } from "lucide-react";
import type { GenerateResponsesHookState } from "./useGenerateResponses";

// State A — pre-generation summary card.
//
// Shows the user what's about to happen and the cost / time estimate.
// Phase 5c: the "Skip preview" toggle is now functional — when on,
// the GenerateAndPushStep transitions directly to the push card instead
// of showing the preview table after generation finishes.

interface Props {
  gen: GenerateResponsesHookState;
}

export function PreGenerationCard({ gen }: Props) {
  const { start, canStart, reasonNotReady, estimate } = gen;
  const status = useResponsesStore((s) => s.status);
  const error = useResponsesStore((s) => s.error);
  const skipPreview = useResponsesStore((s) => s.skipPreview);
  const setSkipPreview = useResponsesStore((s) => s.setSkipPreview);

  const personas = usePersonasStore((s) => s.personas);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questions = useSurveyStore((s) => s.questions.data);
  const draft = useGenerationStore((s) => s.draft);
  const provider = useSetupStore((s) => s.llm.provider);
  const responseModel = useSetupStore((s) => s.llm.responseModel);
  const ssConnectionOk = useSetupStore((s) => s.ssConnection.status === "ok");

  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;
  const totalQuestionCount = questions?.length ?? 0;
  const answerableCount = questions
    ? partitionQuestionsForGeneration(questions).kept.length
    : 0;
  const skippedCount = totalQuestionCount - answerableCount;

  const enabledLanguages = draft.languageDistribution.filter((l) => l.weight > 0);
  const langDescriptor =
    enabledLanguages.length === 1
      ? enabledLanguages[0]!.code.toUpperCase()
      : `${enabledLanguages.length} languages`;

  return (
    <Card className="card-organic">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <CardTitle>Ready to generate responses</CardTitle>
        </div>
        <CardDescription>
          One LLM call per persona — all answers in one shot for per-respondent coherence.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Summary chips */}
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryRow
            label="Personas"
            value={`${personas.length.toLocaleString()} (synthesized this session)`}
          />
          <SummaryRow label="Survey" value={selectedSurvey?.name ?? "—"} />
          <SummaryRow
            label="Questions to answer"
            value={
              skippedCount > 0
                ? `${answerableCount} of ${totalQuestionCount} (${skippedCount} skipped)`
                : `${answerableCount}`
            }
          />
          <SummaryRow label="Languages" value={langDescriptor} />
          <SummaryRow label="Provider" value={provider.toUpperCase()} />
          <SummaryRow
            label="Response model"
            value={getModel(responseModel)?.label ?? responseModel}
          />
        </div>

        {/* Cost + ETA */}
        {estimate && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Estimated cost (response phase)</span>
              <span className="font-mono text-base font-semibold tabular-nums">
                {formatUsd(estimate.totalCost)}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>Estimated wall-clock</span>
              <span className="tabular-nums">{formatMinutes(estimate.totalSeconds)}</span>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Includes a 15% buffer for retries. Up to{" "}
              {provider === "openai" ? "2" : "4"} requests run in parallel; the run
              honors {provider === "openai" ? "OpenAI" : "Anthropic"} rate-limit headers
              and waits when the upstream signals a throttle.
            </p>
          </div>
        )}

        {/* Skip-preview toggle — Phase 5c, requires SS connection */}
        <label
          className={[
            "flex items-start gap-2 rounded-md border p-2.5 transition-colors",
            ssConnectionOk
              ? "cursor-pointer hover:bg-muted/20"
              : "cursor-not-allowed opacity-50",
          ].join(" ")}
        >
          <input
            type="checkbox"
            checked={skipPreview}
            onChange={(e) => ssConnectionOk && setSkipPreview(e.target.checked)}
            disabled={!ssConnectionOk}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <div className="space-y-0.5">
            <span className="block text-sm font-medium">
              Skip preview — push directly to SurveySparrow
            </span>
            <span className="block text-xs text-muted-foreground">
              {ssConnectionOk
                ? "When enabled, responses push to SurveySparrow immediately after generation."
                : "Test your SurveySparrow connection in Setup to enable this."}
            </span>
          </div>
        </label>

        {/* Action area */}
        {!canStart && reasonNotReady && (
          <Alert variant="warning">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Can&apos;t generate yet</AlertTitle>
            <AlertDescription>{reasonNotReady}</AlertDescription>
          </Alert>
        )}

        {(status === "error" || status === "aborted") && error && (
          <Alert variant={status === "aborted" ? "warning" : "destructive"}>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>
              {status === "aborted" ? "Generation cancelled" : "Generation failed"}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void start()}
            disabled={!canStart}
            size="lg"
            className="gap-2"
          >
            <Sparkles className="h-4 w-4" />
            Generate {personas.length.toLocaleString()} responses
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border bg-card/40 px-3 py-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}
