"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Info, Sparkles, ShieldAlert } from "lucide-react";
import {
  COST_TIER_LABELS,
  RISK_LEVEL_LABELS,
  getModelsByProvider,
  getProviderRiskNote,
  groupModelsByMode,
  modelHasKnownPricing,
  type LLMProvider,
  type ModelOption,
} from "@/lib/llm/models";
import { formatPricingShort, pricingVerifiedAt } from "@/lib/llm/pricing";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  id: string;
  label: string;
  description?: string;
  kind: "personas" | "responses";
  provider: LLMProvider;
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({
  id,
  label,
  description,
  kind,
  provider,
  value,
  onChange,
  disabled,
}: ModelSelectorProps) {
  const options = getModelsByProvider(provider);
  const groups = groupModelsByMode(options);
  const current = options.find((o) => o.id === value);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {current && <ModelInfoTooltip model={current} kind={kind} />}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g.mode}>
              <SelectLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.label}
              </SelectLabel>
              {g.models.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  <ModelOptionRow model={opt} kind={kind} />
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {/* Below-the-trigger summary badges so the selected model's flavor is
          visible even when the dropdown is closed. */}
      {current && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <CostBadge model={current} />
          <RiskBadge model={current} />
          {current.recommendedFor.includes(kind) && (
            <Badge
              variant="default"
              className="h-5 gap-1 px-1.5 text-[10px] font-medium leading-none"
            >
              <Sparkles className="h-2.5 w-2.5" />
              Recommended for {kind === "personas" ? "personas" : "responses"}
            </Badge>
          )}
          {!modelHasKnownPricing(current.id) && (
            <Badge
              variant="outline"
              className="h-5 px-1.5 text-[10px] font-medium leading-none text-muted-foreground"
              title="No pricing entry — cost estimator will show 'Pricing unavailable' for this model."
            >
              Pricing unavailable
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row content inside the Select dropdown
// ---------------------------------------------------------------------------

function ModelOptionRow({
  model,
  kind,
}: {
  model: ModelOption;
  kind: "personas" | "responses";
}) {
  const recommended = model.recommendedFor.includes(kind);
  return (
    <div className="flex w-full items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{model.label}</span>
          {recommended && (
            <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          )}
        </div>
        <span className="block truncate text-[11px] text-muted-foreground">
          {model.tagline}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost / risk badges
// ---------------------------------------------------------------------------

function CostBadge({ model }: { model: ModelOption }) {
  const tone =
    model.costTier === "very_low" || model.costTier === "free_or_trial"
      ? "text-emerald-700 border-emerald-300/60 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-700/40 dark:bg-emerald-950/40"
      : model.costTier === "low"
        ? "text-emerald-700 border-emerald-300/40 bg-emerald-50/70 dark:text-emerald-300 dark:border-emerald-800/30 dark:bg-emerald-950/30"
        : model.costTier === "medium"
          ? "text-amber-700 border-amber-300/60 bg-amber-50 dark:text-amber-300 dark:border-amber-700/40 dark:bg-amber-950/40"
          : "text-rose-700 border-rose-300/60 bg-rose-50 dark:text-rose-300 dark:border-rose-700/40 dark:bg-rose-950/40";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        tone,
      )}
    >
      {COST_TIER_LABELS[model.costTier]}
    </span>
  );
}

function RiskBadge({ model }: { model: ModelOption }) {
  if (model.riskLevel === "enterprise_safe" || model.riskLevel === "business_safe") {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-300">
      <ShieldAlert className="h-2.5 w-2.5" />
      {RISK_LEVEL_LABELS[model.riskLevel]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Info tooltip — rich content for the selected model
// ---------------------------------------------------------------------------

function ModelInfoTooltip({
  model,
  kind,
}: {
  model: ModelOption;
  kind: "personas" | "responses";
}) {
  const pricingShort = formatPricingShort(model.id);
  const verifiedAt = pricingVerifiedAt(model.id);
  const recommended = model.recommendedFor.includes(kind);
  const providerRisk = getProviderRiskNote(model.provider);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`More info about ${model.label}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-sm space-y-1.5 text-left">
        <p className="text-sm">{model.tooltip}</p>
        {recommended && (
          <p className="text-[11px] text-primary">
            <Sparkles className="mb-0.5 mr-0.5 inline h-3 w-3" />
            Recommended for {kind === "personas" ? "persona synthesis" : "response generation"}.
          </p>
        )}
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          <li>
            <strong>Quality:</strong> {model.qualityTier} ·{" "}
            <strong>Speed:</strong> {model.speedTier.replace("_", " ")}
          </li>
          {pricingShort ? (
            <li>
              <strong>Pricing:</strong> {pricingShort}
              {verifiedAt && (
                <span className="ml-1 italic">(verified {verifiedAt})</span>
              )}
            </li>
          ) : (
            <li className="italic">
              <strong>Pricing:</strong> not yet verified for this model — cost
              estimator will show &quot;Pricing unavailable&quot;.
            </li>
          )}
          {model.notes && (
            <li>
              <strong>Note:</strong> {model.notes}
            </li>
          )}
          {providerRisk && (
            <li className="text-amber-700 dark:text-amber-400">
              <ShieldAlert className="mb-0.5 mr-0.5 inline h-3 w-3" />
              {providerRisk}
            </li>
          )}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
