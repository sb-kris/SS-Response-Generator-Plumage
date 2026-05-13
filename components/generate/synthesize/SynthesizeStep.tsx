"use client";

import { useEffect, useMemo, useState } from "react";
import { useGenerationStore } from "@/store/generation-store";
import { useSurveyStore } from "@/store/survey-store";
import { useSetupStore } from "@/store/setup-store";
import { hashSynthesisInputs, usePersonasStore } from "@/store/personas-store";
import { useResponsesStore } from "@/store/responses-store";
import { useWizardStore } from "@/store/wizard-store";
import { getModel } from "@/lib/llm/models";
import {
  formatMinutes,
  formatUsd,
} from "@/lib/generation/cost-estimator";
import { LANGUAGES_BY_CODE } from "@/lib/utils/language-geography";
import { summarizePersonas } from "@/lib/generation/persona-types";
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
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSynthesize, type SynthesizeHookState } from "./useSynthesize";
import { PersonaTable } from "./PersonaTable";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { RotatingLoadingMessage } from "@/components/ui/RotatingLoadingMessage";
import { PERSONA_SYNTHESIS_MESSAGES } from "@/lib/copy/loading-messages";

// ---------------------------------------------------------------------------
// Top-level component — picks a sub-state to render
// ---------------------------------------------------------------------------

export function SynthesizeStep() {
  const status = usePersonasStore((s) => s.status);
  const personas = usePersonasStore((s) => s.personas);
  const setStep = useWizardStore((s) => s.setStep);

  // CRITICAL: useSynthesize must be called HERE, not inside the child cards.
  //
  // The synthesis run's AbortController lives in this hook's `useRef`. If a
  // child card called the hook, that card would unmount when the JSX swaps
  // to a different card (e.g. running → complete), and the unmount-cleanup
  // effect would abort the in-flight controller. By keeping the hook at
  // the parent level, the AbortController survives card transitions and is
  // only torn down when the user actually leaves the synthesize step.
  const synth = useSynthesize();

  return (
    <div className="space-y-4">
      {/* Selected-survey breadcrumb (mirrors ConfigureStep's pattern) */}
      <div className="flex items-center gap-2 text-sm">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStep(2)}
          className="h-8 -ml-2 gap-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to configure
        </Button>
      </div>

      {status === "running" ? (
        <RunningCard synth={synth} />
      ) : personas.length > 0 ? (
        // Phase 7a: also show CompletedCard when status is interrupted /
        // error / aborted but partial personas exist — the recovery
        // banner inside makes the partial state explicit, and the user
        // can either continue with what's saved or re-synthesize.
        <CompletedCard synth={synth} />
      ) : (
        <PreSynthesisCard synth={synth} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pre-synthesis state — config summary + Synthesize button
// ---------------------------------------------------------------------------

function PreSynthesisCard({ synth }: { synth: SynthesizeHookState }) {
  const { start, canStart, reasonNotReady, estimate } = synth;
  const status = usePersonasStore((s) => s.status);
  const error = usePersonasStore((s) => s.error);
  const draft = useGenerationStore((s) => s.draft);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const personaModel = useSetupStore((s) => s.llm.personaModel);
  const responseModel = useSetupStore((s) => s.llm.responseModel);
  const provider = useSetupStore((s) => s.llm.provider);

  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;
  const responseCount = draft.timeRange.responseCount;
  const themeCount = draft.themes.length;
  const enabledLanguages = draft.languageDistribution.filter((l) => l.weight > 0);
  const distLabel = describeDistribution(draft.personaDistribution);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <CardTitle>Ready to synthesize personas</CardTitle>
          </div>
          <CardDescription>
            Generates persona profiles only — no responses are pushed to SurveySparrow yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Summary chips */}
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryRow label="Survey" value={selectedSurvey?.name ?? "—"} />
            <SummaryRow label="Responses" value={responseCount.toLocaleString()} />
            <SummaryRow
              label="Languages"
              value={
                enabledLanguages.length === 0
                  ? "—"
                  : enabledLanguages
                      .map((l) => `${l.code.toUpperCase()} ${l.weight}%`)
                      .join(" · ")
              }
            />
            <SummaryRow
              label="Themes"
              value={
                themeCount === 0
                  ? "(none)"
                  : `${themeCount} configured`
              }
            />
            <SummaryRow
              label="Countries"
              value={
                (draft.countryFilter ?? []).length === 0
                  ? "All (from languages)"
                  : (draft.countryFilter ?? [])
                      .slice(0, 4)
                      .map((c) => c.code)
                      .join(", ") +
                    ((draft.countryFilter ?? []).length > 4
                      ? ` +${(draft.countryFilter ?? []).length - 4} more`
                      : "")
              }
            />
            <SummaryRow label="Distribution" value={distLabel} />
            <SummaryRow
              label="Provider"
              value={`${provider.toUpperCase()}`}
            />
            <SummaryRow
              label="Persona model"
              value={getModel(personaModel)?.label ?? personaModel}
            />
            <SummaryRow
              label="Response model"
              value={getModel(responseModel)?.label ?? responseModel}
              muted
            />
          </div>

          {/* Cost + ETA */}
          {estimate && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-muted-foreground">Estimated cost (full pipeline)</span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  <AnimatedNumber
                    value={estimate.totalCost ?? 0}
                    format={(n) => formatUsd(n)}
                    duration={0.45}
                  />
                </span>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>Estimated wall-clock</span>
                <span className="tabular-nums">{formatMinutes(estimate.totalSeconds)}</span>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Persona synthesis runs first — response generation will run later from this same set.
              </p>
            </div>
          )}

          {/* Action area */}
          {!canStart && reasonNotReady && (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Can&apos;t start synthesis yet</AlertTitle>
              <AlertDescription>{reasonNotReady}</AlertDescription>
            </Alert>
          )}

          {(status === "error" || status === "aborted") && error && (
            <Alert variant={status === "aborted" ? "warning" : "destructive"}>
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>
                {status === "aborted" ? "Synthesis cancelled" : "Synthesis failed"}
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
              Synthesize {responseCount.toLocaleString()} personas
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running state — progress bar, rotating message, ETA, cancel
// ---------------------------------------------------------------------------

function RunningCard({ synth }: { synth: SynthesizeHookState }) {
  const { cancel } = synth;
  const progress = usePersonasStore((s) => s.progress);
  const warnings = progress.warnings;

  const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  // ETA: count down from estimatedSeconds, but bias toward what we've actually
  // observed so far (linear extrapolation of elapsed × remaining/done).
  const eta = useEta(progress);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <CardTitle>Synthesizing personas…</CardTitle>
        </div>
        <CardDescription>
          <RotatingLoadingMessage pool={PERSONA_SYNTHESIS_MESSAGES} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">
              Generated{" "}
              <span className="font-mono tabular-nums">{progress.completed.toLocaleString()}</span>
              {" / "}
              <span className="font-mono tabular-nums">{progress.total.toLocaleString()}</span>
              {" persona profiles"}
            </span>
            {progress.totalBatches > 0 && (
              <span className="text-xs text-muted-foreground">
                Batch {progress.currentBatch}/{progress.totalBatches}
              </span>
            )}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
            />
          </div>
          <div className="flex items-baseline justify-between text-xs text-muted-foreground">
            <span>{Math.round(pct)}% complete</span>
            {eta && <span className="tabular-nums">ETA: {eta}</span>}
          </div>
        </div>

        {warnings.length > 0 && (
          <Alert variant="warning">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Recoverable issues</AlertTitle>
            <AlertDescription className="space-y-1">
              {warnings.slice(-3).map((w, i) => (
                <div key={i} className="text-xs">
                  {w}
                </div>
              ))}
              {warnings.length > 3 && (
                <div className="text-[10px] text-muted-foreground">
                  (+{warnings.length - 3} earlier — synthesis will continue with defaults for affected personas)
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div>
          <Button variant="outline" size="sm" onClick={cancel} className="gap-1.5">
            <X className="h-3.5 w-3.5" />
            Cancel synthesis
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function useEta(progress: { completed: number; total: number; startedAt: number | null; estimatedSeconds: number | null }): string | null {
  const [, force] = useState(0);
  // Tick every 1s so the ETA actually counts down even when no progress event arrives.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!progress.startedAt) return null;
  const elapsed = (Date.now() - progress.startedAt) / 1000;

  // Prefer empirical extrapolation once we have at least 1 complete persona.
  if (progress.completed > 0 && progress.total > 0) {
    const remaining = (elapsed / progress.completed) * (progress.total - progress.completed);
    return formatSeconds(Math.max(0, remaining));
  }
  if (progress.estimatedSeconds) {
    return formatSeconds(Math.max(0, progress.estimatedSeconds - elapsed));
  }
  return null;
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.ceil(s)}s`;
  const mins = Math.ceil(s / 60);
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Completed state — stats, persona table, continue / re-synthesize
// ---------------------------------------------------------------------------

function CompletedCard({ synth }: { synth: SynthesizeHookState }) {
  const personas = usePersonasStore((s) => s.personas);
  const warnings = usePersonasStore((s) => s.progress.warnings);
  const status = usePersonasStore((s) => s.status);
  const error = usePersonasStore((s) => s.error);
  const finishRun = usePersonasStore((s) => s.finishRun);
  const sourceConfigHash = usePersonasStore((s) => s.sourceConfigHash);
  const draft = useGenerationStore((s) => s.draft);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const reset = usePersonasStore((s) => s.reset);
  const setStep = useWizardStore((s) => s.setStep);
  const { start } = synth;

  const isPartial = status !== "complete";

  // Re-hash so we can flip status to "complete" when accepting partials.
  function handleAcceptPartial() {
    const hash =
      sourceConfigHash ??
      hashSynthesisInputs({
        responseCount: draft.timeRange.responseCount,
        surveyId: selectedSurveyId,
        draftJson: JSON.stringify(draft),
      });
    finishRun(personas, hash);
  }

  const summary = useMemo(() => summarizePersonas(personas), [personas]);
  const total = summary.total;

  const sentimentCounts = summary.bySentiment;
  const promoterPct = pct(sentimentCounts.promoter, total);
  const passivePct = pct(sentimentCounts.passive, total);
  const detractorPct = pct(sentimentCounts.detractor, total);

  const langEntries = Object.entries(summary.byLanguage)
    .map(([code, count]) => ({
      code,
      count,
      label: LANGUAGES_BY_CODE[code]?.name ?? code.toUpperCase(),
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-4">
      <Card className="card-organic-static">
        <CardHeader>
          <div className="flex items-center gap-2">
            {isPartial ? (
              <ShieldAlert className="h-5 w-5 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-success" />
            )}
            <CardTitle>
              <AnimatedNumber value={total} />{" "}
              {isPartial ? "personas saved (run incomplete)" : "personas synthesized"}
            </CardTitle>
          </div>
          <CardDescription>
            {isPartial
              ? "The previous run didn't finish — you can use what was saved or re-synthesize from scratch."
              : "Inspect the breakdown below. Continue to generate responses, or re-synthesize for a different mix."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Recovery banner — shown when accepting a partially-saved run */}
          {isPartial && (
            <Alert variant={status === "error" ? "destructive" : "warning"}>
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>
                {status === "interrupted"
                  ? "Synthesis was interrupted"
                  : status === "aborted"
                    ? "Synthesis was cancelled"
                    : "Synthesis ended with an error"}
              </AlertTitle>
              <AlertDescription className="space-y-2">
                {error && <p className="text-xs">{error}</p>}
                <p className="text-xs">
                  {total.toLocaleString()} personas were saved. Click{" "}
                  <span className="font-medium">Use these personas</span> to keep them
                  and continue, or <span className="font-medium">Re-synthesize</span>{" "}
                  for a fresh run.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" onClick={handleAcceptPartial} className="gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Use these personas
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Stat grid — alternating organic / mirror corners create rhythm */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              className="card-organic-static"
              title="Sentiment"
              primaryNode={
                <span className="flex items-baseline gap-1">
                  <AnimatedNumber value={sentimentCounts.promoter} />
                  <span className="text-muted-foreground">/</span>
                  <AnimatedNumber value={sentimentCounts.passive} />
                  <span className="text-muted-foreground">/</span>
                  <AnimatedNumber value={sentimentCounts.detractor} />
                </span>
              }
              secondary={`Promoter ${promoterPct}% · Passive ${passivePct}% · Detractor ${detractorPct}%`}
            />
            <StatTile
              className="card-organic-static-mirror"
              title="Languages"
              primaryNode={
                <span>
                  <AnimatedNumber value={langEntries.length} />{" "}
                  {langEntries.length === 1 ? "language" : "languages"}
                </span>
              }
              secondary={
                langEntries
                  .slice(0, 3)
                  .map((l) => `${l.count} ${l.label}`)
                  .join(" · ") +
                (langEntries.length > 3 ? ` · +${langEntries.length - 3} more` : "")
              }
            />
            <StatTile
              className="card-organic-static"
              title="Top concerns"
              primary={summary.topConcerns[0]?.concern ?? "—"}
              secondary={
                summary.topConcerns
                  .slice(1, 3)
                  .map((c) => c.concern)
                  .join(" · ") || "Generated from persona personalities"
              }
            />
          </div>

          {warnings.length > 0 && (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Synthesis completed with notes</AlertTitle>
              <AlertDescription className="space-y-1">
                {warnings.slice(0, 3).map((w, i) => (
                  <div key={i} className="text-xs">{w}</div>
                ))}
                {warnings.length > 3 && (
                  <div className="text-[10px] text-muted-foreground">
                    (+{warnings.length - 3} more)
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          <PersonaTable personas={personas} />

          <div className="flex flex-wrap gap-2 pt-2">
            {!isPartial && (
              // Only show "Continue" once status === "complete". Partial
              // personas must be explicitly accepted via the alert above
              // first — otherwise downstream gates fail with a confusing
              // "Synthesize first" message.
              <Button size="lg" onClick={() => setStep(4)} className="gap-2">
                Continue to generate responses
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant={isPartial ? "default" : "outline"}
              size="lg"
              onClick={() => {
                // Cascade reset — partial responses for the OLD persona set
                // would otherwise become orphaned (pointing at IDs that no
                // longer exist).
                useResponsesStore.getState().reset();
                reset();
                void start();
              }}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Re-synthesize
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                useResponsesStore.getState().reset();
                reset();
              }}
            >
              Discard personas
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small atoms
// ---------------------------------------------------------------------------

function SummaryRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 rounded-md border bg-card/40 px-3 py-2",
        muted && "opacity-60",
      )}
    >
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

function StatTile({
  title,
  primary,
  primaryNode,
  secondary,
  className,
}: {
  title: string;
  primary?: string;
  primaryNode?: React.ReactNode;
  secondary: string;
  /** Extra classes — used to pass card-organic-static* shape variants. */
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card/40 p-3", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-1 truncate text-base font-semibold">
        {primaryNode ?? primary}
      </p>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{secondary}</p>
    </div>
  );
}

function pct(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 100);
}

function describeDistribution(d: { promoter: number; passive: number; detractor: number }): string {
  return `${d.promoter}% / ${d.passive}% / ${d.detractor}%`;
}
