"use client";

import { useMemo, useState } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { partitionQuestionsForGeneration } from "@/lib/surveysparrow/types";
import {
  getModel,
  getProviderLabel,
  modelHasKnownPricing,
  COST_TIER_LABELS,
} from "@/lib/llm/models";
import {
  estimateCost,
  computeSuggestion,
  computeAlternativeCosts,
  STANDARD_ALTERNATIVE_PAIRS,
  formatUsd,
  formatMinutes,
  formatTokens,
  type CostEstimate,
} from "@/lib/generation/cost-estimator";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Lightbulb,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CostEstimatorPanel() {
  const personaModelId = useSetupStore((s) => s.llm.personaModel);
  const responseModelId = useSetupStore((s) => s.llm.responseModel);
  const provider = useSetupStore((s) => s.llm.provider);
  const questions = useSurveyStore((s) => s.questions);
  const languageDistribution = useGenerationStore((s) => s.draft.languageDistribution);
  const responseCount = useGenerationStore((s) => s.draft.timeRange.responseCount);

  // Answerable question count from the selected survey.
  const questionCount = useMemo(() => {
    const data = questions.data ?? [];
    if (data.length === 0) return 0;
    const { kept } = partitionQuestionsForGeneration(data);
    return kept.length;
  }, [questions.data]);

  // Proportion of responses that will be in non-English languages.
  const nonEnglishFraction = useMemo(() => {
    const englishWeight = languageDistribution.find((l) => l.code === "en")?.weight ?? 100;
    return Math.max(0, Math.min(1, (100 - englishWeight) / 100));
  }, [languageDistribution]);

  const estimateInput = useMemo(
    () => ({ responseCount, questionCount, personaModelId, responseModelId, nonEnglishFraction }),
    [responseCount, questionCount, personaModelId, responseModelId, nonEnglishFraction],
  );

  const estimate = useMemo(() => estimateCost(estimateInput), [estimateInput]);

  const suggestion = useMemo(
    () => computeSuggestion(estimate, estimateInput),
    [estimate, estimateInput],
  );

  // Comparison row — drop the row matching the current pair so we don't show
  // "Balanced: $X" when the user is already on Balanced.
  const alternatives = useMemo(() => {
    return computeAlternativeCosts(estimateInput, STANDARD_ALTERNATIVE_PAIRS).filter(
      (alt) =>
        !(
          alt.personaModelId === personaModelId &&
          alt.responseModelId === responseModelId
        ),
    );
  }, [estimateInput, personaModelId, responseModelId]);

  const personaModel = getModel(personaModelId);
  const responseModel = getModel(responseModelId);
  const providerLabel = getProviderLabel(provider);

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [compactExpanded, setCompactExpanded] = useState(false);

  const noSurvey = questionCount === 0;

  const panelBodyProps: PanelBodyProps = {
    estimate,
    responseCount,
    questionCount,
    personaModelLabel: personaModel?.label ?? personaModelId,
    responseModelLabel: responseModel?.label ?? responseModelId,
    personaCostTier: personaModel
      ? COST_TIER_LABELS[personaModel.costTier]
      : undefined,
    responseCostTier: responseModel
      ? COST_TIER_LABELS[responseModel.costTier]
      : undefined,
    personaModelMode: personaModel?.mode,
    providerLabel,
    languageDistribution,
    noSurvey,
    suggestion,
    alternatives,
    breakdownOpen,
    onBreakdownToggle: () => setBreakdownOpen((v) => !v),
  };

  return (
    <>
      {/* Compact bar for <lg screens */}
      <div className="lg:hidden">
        <CompactBar
          estimate={estimate}
          expanded={compactExpanded}
          onToggle={() => setCompactExpanded((v) => !v)}
        />
        {compactExpanded && (
          <div className="mt-2 rounded-lg border bg-card/40 p-4">
            <PanelBody {...panelBodyProps} />
          </div>
        )}
      </div>

      {/* Full panel for lg+ screens.
          Glass treatment: stuck in place while content scrolls behind it,
          so we fog that content through the panel surface. Softer border,
          larger radius for the floating feel. */}
      <aside
        className="hidden rounded-xl border border-border/50 bg-card/60 p-4 shadow-sm backdrop-blur-xl supports-[backdrop-filter]:bg-card/40 lg:block"
      >
        <PanelBody {...panelBodyProps} />
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Compact bar (<lg)
// ---------------------------------------------------------------------------

function CompactBar({
  estimate,
  expanded,
  onToggle,
}: {
  estimate: CostEstimate;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-lg border bg-card/40 px-4 py-2.5 text-sm"
    >
      <span className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
        <span>
          {estimate.unknownPricing ? (
            <span className="text-muted-foreground">Pricing unavailable</span>
          ) : (
            <>
              <span className="font-mono font-semibold tabular-nums">
                <AnimatedNumber
                  value={estimate.totalCost ?? 0}
                  format={(n) => formatUsd(n)}
                  duration={0.45}
                />
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {formatMinutes(estimate.totalSeconds)}
              </span>
            </>
          )}
        </span>
      </span>
      <ChevronDown
        className={cn(
          "h-3.5 w-3.5 text-muted-foreground transition-transform",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Full panel body
// ---------------------------------------------------------------------------

interface PanelBodyProps {
  estimate: CostEstimate;
  responseCount: number;
  questionCount: number;
  personaModelLabel: string;
  responseModelLabel: string;
  personaCostTier?: string;
  responseCostTier?: string;
  personaModelMode?: string;
  providerLabel: string;
  languageDistribution: { code: string; weight: number }[];
  noSurvey: boolean;
  suggestion: ReturnType<typeof computeSuggestion>;
  alternatives: ReturnType<typeof computeAlternativeCosts>;
  breakdownOpen: boolean;
  onBreakdownToggle: () => void;
}

function PanelBody({
  estimate,
  responseCount,
  questionCount,
  personaModelLabel,
  responseModelLabel,
  personaCostTier,
  responseCostTier,
  personaModelMode,
  providerLabel,
  languageDistribution,
  noSurvey,
  suggestion,
  alternatives,
  breakdownOpen,
  onBreakdownToggle,
}: PanelBodyProps) {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Estimated Cost
      </div>

      {noSurvey && (
        <p className="text-[11px] text-muted-foreground">
          Pick a survey to refine the estimate — using a rough average question count until then.
        </p>
      )}

      {/* Unknown-pricing banner */}
      {estimate.pricingWarnings.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-300/60 bg-amber-50/70 p-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {estimate.pricingWarnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {/* Persona phase */}
      <PhaseRow
        icon="🤖"
        label="Persona synthesis"
        count={responseCount}
        model={personaModelLabel}
        tokens={estimate.persona.totalTokens}
        cost={estimate.persona.cost}
        unknownPricing={estimate.persona.unknownPricing}
      />

      {/* Response phase */}
      <PhaseRow
        icon="✍️"
        label="Response generation"
        count={responseCount}
        model={responseModelLabel}
        tokens={estimate.response.totalTokens}
        cost={estimate.response.cost}
        unknownPricing={estimate.response.unknownPricing}
      />

      {/* Total */}
      <div className="border-t pt-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">Total</span>
          <span className="font-mono text-xl font-bold tabular-nums">
            {estimate.unknownPricing && estimate.totalCost === null ? (
              "—"
            ) : (
              <AnimatedNumber
                value={estimate.totalCost ?? 0}
                format={(n) => formatUsd(n)}
                duration={0.45}
              />
            )}
            {estimate.unknownPricing && estimate.totalCost !== null && (
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                (partial)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>Wall-clock</span>
          <span className="tabular-nums">{formatMinutes(estimate.totalSeconds)}</span>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Estimates include a 15% buffer for retries and variability. Actual cost depends on prompt length and validator retries.
        </p>
      </div>

      {/* Suggestion */}
      {suggestion && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border p-2.5 text-[11px] leading-relaxed",
            suggestion.icon === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : suggestion.icon === "warn"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{suggestion.text}</span>
        </div>
      )}

      {/* Alternative comparisons — Economy / Balanced / Premium */}
      {alternatives.length > 0 && (
        <div className="space-y-1 rounded-md border bg-muted/20 p-2 text-[11px]">
          <p className="font-semibold text-foreground">Other modes</p>
          {alternatives.map((alt) => (
            <div
              key={alt.label}
              className="flex items-baseline justify-between gap-2 text-muted-foreground"
            >
              <span className="truncate">{alt.label}</span>
              <span className="font-mono tabular-nums text-foreground">
                {formatUsd(alt.estimate.totalCost)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Mini breakdown */}
      <div className="border-t pt-2.5 space-y-1 text-[11px] text-muted-foreground">
        <MiniRow label="Provider" value={providerLabel} />
        <MiniRow label="Persona model" value={personaModelLabel} hint={personaCostTier} />
        <MiniRow label="Response model" value={responseModelLabel} hint={responseCostTier} />
        {personaModelMode && (
          <MiniRow label="Mode" value={personaModelMode.replace(/_/g, " ")} />
        )}
        <MiniRow
          label="Languages"
          value={languageDistribution
            .filter((l) => l.weight > 0)
            .map((l) => `${l.code} ${l.weight}%`)
            .join(", ")}
        />
        <MiniRow label="Responses" value={responseCount.toLocaleString()} />
      </div>

      {/* Expandable math breakdown */}
      <button
        type="button"
        onClick={onBreakdownToggle}
        className="flex w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", breakdownOpen && "rotate-90")}
        />
        How is this calculated?
      </button>

      {breakdownOpen && (
        <BreakdownTable estimate={estimate} questionCount={questionCount} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase row
// ---------------------------------------------------------------------------

function PhaseRow({
  icon,
  label,
  count,
  model,
  tokens,
  cost,
  unknownPricing,
}: {
  icon: string;
  label: string;
  count: number;
  model: string;
  tokens: number;
  cost: number | null;
  unknownPricing: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <span aria-hidden>{icon}</span>
          {label}
        </span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            unknownPricing && "text-muted-foreground italic",
          )}
        >
          {unknownPricing ? "Pricing unavailable" : formatUsd(cost)}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {count.toLocaleString()} × {model} · ~{formatTokens(tokens)} tokens
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini breakdown row
// ---------------------------------------------------------------------------

function MiniRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span>{label}</span>
      <span className="truncate text-right">
        <span className="font-medium text-foreground">{value}</span>
        {hint && (
          <span className="ml-1 text-[10px] text-muted-foreground">{hint}</span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable math breakdown table
// ---------------------------------------------------------------------------

function BreakdownTable({
  estimate,
  questionCount,
}: {
  estimate: CostEstimate;
  questionCount: number;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-2.5 text-[10px] leading-relaxed space-y-2">
      <p className="font-semibold text-foreground">Persona phase</p>
      <table className="w-full text-muted-foreground">
        <tbody>
          <tr>
            <td>Batches</td>
            <td className="text-right tabular-nums">{estimate.batchCount}</td>
          </tr>
          <tr>
            <td>Input tokens</td>
            <td className="text-right tabular-nums">{formatTokens(estimate.persona.inputTokens)}</td>
          </tr>
          <tr>
            <td>Output tokens</td>
            <td className="text-right tabular-nums">{formatTokens(estimate.persona.outputTokens)}</td>
          </tr>
        </tbody>
      </table>

      <p className="font-semibold text-foreground">Response phase</p>
      <table className="w-full text-muted-foreground">
        <tbody>
          <tr>
            <td>Questions answered</td>
            <td className="text-right tabular-nums">{questionCount || "est."}</td>
          </tr>
          <tr>
            <td>Survey context tokens</td>
            <td className="text-right tabular-nums">{formatTokens(estimate.surveyContextTokens)}</td>
          </tr>
          <tr>
            <td>Non-English multiplier</td>
            <td className="text-right tabular-nums">×{estimate.nonEnglishMultiplier.toFixed(2)}</td>
          </tr>
          <tr>
            <td>Input tokens</td>
            <td className="text-right tabular-nums">{formatTokens(estimate.response.inputTokens)}</td>
          </tr>
          <tr>
            <td>Output tokens</td>
            <td className="text-right tabular-nums">{formatTokens(estimate.response.outputTokens)}</td>
          </tr>
        </tbody>
      </table>

      <p className="font-semibold text-foreground">Adjustments</p>
      <table className="w-full text-muted-foreground">
        <tbody>
          <tr>
            <td>Retry buffer</td>
            <td className="text-right tabular-nums">×{estimate.bufferFactor}</td>
          </tr>
          <tr>
            <td>Response concurrency</td>
            <td className="text-right tabular-nums">
              {estimate.responseConcurrency}× parallel calls
            </td>
          </tr>
        </tbody>
      </table>

      <div className="flex items-start gap-1.5 pt-1 text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Token counts are estimates. Actual usage depends on model, language,
          and response length. Pricing from{" "}
          <span className="font-medium text-foreground">lib/llm/pricing.ts</span>.
        </span>
      </div>
    </div>
  );
}
