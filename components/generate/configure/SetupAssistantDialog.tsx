"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Sparkles,
  Loader2,
  ChevronRight,
  Check,
  AlertTriangle,
  ArrowLeft,
  Plus,
  CircleCheck,
  Building2,
  Globe,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  SENTIMENT_SHAPES,
  distributionForShape,
  timingForSurveyType,
  type SentimentShape,
  type SetupAssistantInputs,
  type SetupAssistantLLMOutput,
  type SetupAssistantRequest,
  type SetupAssistantResponse,
  type SetupAssistantSuggestion,
  type SurveySparrowVariableSummary,
  type VariableSuggestion,
} from "@/lib/generation/setup-assistant-types";
import { useGenerationStore } from "@/store/generation-store";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import {
  estimateAiSetupCost,
  formatAiSetupCost,
  type AiSetupCostEstimate,
} from "@/lib/generation/cost-estimator";
import { getModel } from "@/lib/llm/models";
import type { CustomVariable, ThemeConfig } from "@/lib/profiles/types";
import { extractQuestionDisplay } from "@/lib/surveysparrow/types";

// AI Setup Assistant — Phase 8.
//
// Flow:
//   1. inputs   — company name / website / sentiment shape / notes
//   2. loading  — parallel fetches: SS variables + LLM call
//   3. preview  — selectable sections + per-variable add buttons
//
// Every "apply" calls setDraft() with the user's selected pieces only.
// Existing config is preserved on sections the user does NOT tick. Sections
// the user DOES tick get a "Replace" warning when content is already present.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "inputs" | "loading" | "preview" | "error";

interface ApplyToggles {
  context: boolean;
  themes: boolean;
  personaDistribution: boolean;
  timing: boolean;
  // Variables are per-row, not per-section.
}

export function SetupAssistantDialog({ open, onOpenChange }: Props) {
  const draft = useGenerationStore((s) => s.draft);
  const setDraft = useGenerationStore((s) => s.setDraft);
  const ss = useSetupStore((s) => s.surveySparrow);
  const llmSetup = useSetupStore((s) => s.llm);
  const surveyId = useSurveyStore((s) => s.selectedSurveyId);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const questions = useSurveyStore((s) => s.questions.data);

  const survey = useMemo(
    () => (surveys && surveyId ? surveys.find((s) => s.id === surveyId) ?? null : null),
    [surveys, surveyId],
  );

  // ---- Step + form state ----
  // (state declared first so the cost-estimate memo below can read them.)
  const [step, setStep] = useState<Step>("inputs");
  const [companyName, setCompanyName] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [sentimentShape, setSentimentShape] = useState<SentimentShape>("balanced");
  const [notes, setNotes] = useState("");

  // ---- Result state ----
  const [llmOutput, setLlmOutput] = useState<SetupAssistantLLMOutput | null>(null);
  const [ssVariables, setSsVariables] = useState<SurveySparrowVariableSummary[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // ---- Apply selection ----
  const [toggles, setToggles] = useState<ApplyToggles>({
    context: true,
    themes: true,
    personaDistribution: true,
    timing: true,
  });
  const [variablesToAdd, setVariablesToAdd] = useState<Set<string>>(new Set());

  // ---- Pre-run cost estimate (8e) ----------------------------------------
  // The AI Setup Assistant adds an LLM call BEFORE persona/response
  // generation, so surface its expected cost in the inputs step. The
  // estimate uses the user's selected RESPONSE model (the same one the
  // route picks at submit time) and the SS variable count we've already
  // fetched from the workspace. Pricing-unavailable cases fall through
  // to "Pricing unavailable" copy instead of guessing a number.
  const setupCostEstimate: AiSetupCostEstimate = useMemo(
    () =>
      estimateAiSetupCost({
        modelId: llmSetup.responseModel,
        provider: llmSetup.provider,
        companyNameLen: companyName.length,
        notesLen: notes.length,
        existingUseCaseLen: draft.useCase.length,
        surveyName: survey?.name,
        surveyType: survey?.survey_type,
        questionCount: questions?.length ?? 0,
        ssVariableCount: ssVariables.length,
        hasWebSearch: llmSetup.provider === "anthropic",
      }),
    [
      llmSetup.responseModel,
      llmSetup.provider,
      companyName,
      notes,
      draft.useCase,
      survey,
      questions,
      ssVariables,
    ],
  );

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setStep("inputs");
      setLlmOutput(null);
      setSsVariables([]);
      setErrorMessage(null);
      setVariablesToAdd(new Set());
    }
  }, [open]);

  // (No early-return-on-closed here — shadcn's <Dialog> handles its own
  // mount/unmount based on the `open` prop, and an early return would
  // place the `useMemo` below conditionally, violating the rules of
  // hooks. The whole component stays mounted; React just doesn't show
  // the children when `open` is false.)

  // ---- Guard rails ----
  const blockingError = (() => {
    if (!ss.apiKey) return "SurveySparrow API key is missing — go back to Setup.";
    if (!llmSetup.apiKey) return "LLM API key is missing — go back to Setup.";
    if (!surveyId || !survey) return "No survey selected — pick one in Step 1.";
    return null;
  })();

  // ---- Submit (Step 1 → Step 2 → Step 3) ----
  async function handleGenerate() {
    if (!companyName.trim()) {
      toast.error("Company name is required.");
      return;
    }
    if (!survey || !surveyId) return;
    setStep("loading");
    setErrorMessage(null);

    const trimmedQs = (questions ?? []).slice(0, 30).map((q) => {
      const d = extractQuestionDisplay(q);
      return {
        position: d.position,
        text: d.text,
        type: d.type,
        required: d.required,
        choices: d.choices?.slice(0, 12).map((c) => ({ id: c.id, text: c.text })),
      };
    });

    // Parallel fetches: SS variables + LLM call. Both are independent.
    // We pre-fetch SS variables so the LLM can avoid suggesting duplicates,
    // but the LLM call still proceeds if SS vars stall (3s budget).
    type SSVarsResult = { ok: boolean; variables?: SurveySparrowVariableSummary[]; error?: string };
    const ssVarsPromise: Promise<SSVarsResult> = fetch("/api/surveysparrow/variables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: ss.region, apiKey: ss.apiKey, surveyId }),
      cache: "no-store",
    })
      .then((r) => r.json() as Promise<SSVarsResult>)
      .catch((err): SSVarsResult => ({
        ok: false,
        error: err instanceof Error ? err.message : "Network error",
      }));

    let ssVars: SurveySparrowVariableSummary[] = [];
    const ssRace = await Promise.race<SSVarsResult | null>([
      ssVarsPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    if (ssRace && ssRace.ok && Array.isArray(ssRace.variables)) {
      ssVars = ssRace.variables;
      setSsVariables(ssVars);
    } else if (ssRace && !ssRace.ok && ssRace.error) {
      // Soft fail — log to console; the LLM call still proceeds.
      console.warn("[setup-assistant] SS variables fetch failed:", ssRace.error);
    }

    const reqBody: SetupAssistantRequest = {
      inputs: {
        companyName: companyName.trim(),
        companyWebsite: companyWebsite.trim() || undefined,
        sentimentShape,
        notes: notes.trim() || undefined,
      },
      survey: {
        name: survey.name,
        type: survey.survey_type,
        questions: trimmedQs,
      },
      existing: {
        useCase: draft.useCase || undefined,
        customVariableIdentifiers: draft.customVariables.map((v) => v.apiIdentifier),
      },
      surveySparrowVariables: ssVars,
      llm: {
        provider: llmSetup.provider,
        apiKey: llmSetup.apiKey,
        model: llmSetup.responseModel,
        customModelId:
          llmSetup.responseModel === "openrouter:custom"
            ? llmSetup.customResponseModelId
            : undefined,
      },
    };

    try {
      const res = await fetch("/api/llm/setup-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        cache: "no-store",
      });
      const data = (await res.json()) as SetupAssistantResponse;
      if (!data.ok && !data.output) {
        setErrorMessage(data.error ?? "Setup assistant failed.");
        setStep("error");
        return;
      }
      if (data.output) {
        setLlmOutput(data.output);
        // Default: pre-tick all NEW variables for adding (skip ones the
        // draft already has by apiIdentifier). After 8d the LLM owns
        // BOTH the SS-enriched and AI-suggested variable lists in a
        // single array, so the pre-tick logic walks just that one list.
        // The legacy "ss:" prefix is gone — apiIdentifier is unique
        // across SS-enriched and AI-suggested variables (the prompt
        // tells the LLM not to repeat identifiers).
        const existingIds = new Set(draft.customVariables.map((v) => v.apiIdentifier));
        const toAdd = new Set<string>();
        for (const v of data.output.customVariables) {
          if (!existingIds.has(v.apiIdentifier)) toAdd.add(v.apiIdentifier);
        }
        setVariablesToAdd(toAdd);
        setStep("preview");
      } else {
        setErrorMessage(data.error ?? "Empty response.");
        setStep("error");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
      setStep("error");
    }
  }

  // ---- Build a SetupAssistantSuggestion that the apply step can use ----
  const suggestion: SetupAssistantSuggestion | null = useMemo(() => {
    if (!llmOutput || !survey) return null;
    const themes: ThemeConfig[] = llmOutput.themes.map((t) => ({
      id: crypto.randomUUID(),
      label: t.label,
      weight: t.weight,
    }));
    const existingIds = new Set(draft.customVariables.map((v) => v.apiIdentifier));
    // Lowercased SS variable names → original metadata, used so that
    // when the LLM enriches an SS variable, we tag the source correctly
    // even if the LLM forgot to set the `source` field on its output.
    const ssByLowerName = new Map(
      ssVariables.map((v) => [v.name.toLowerCase(), v] as const),
    );

    // PRIMARY path: walk the LLM's enriched variables. The LLM was
    // instructed to return BOTH the existing SS variables (with real
    // option values) AND any new AI-suggested ones — all in this list.
    const llmVarSuggestions: VariableSuggestion[] = llmOutput.customVariables.map((v) => {
      const ssMatch = ssByLowerName.get(v.apiIdentifier.toLowerCase());
      // Source: prefer the LLM's explicit declaration, fall back to
      // apiIdentifier-matching against the SS workspace list.
      const source: VariableSuggestion["source"] =
        v.source === "surveysparrow_variable" || ssMatch
          ? "surveysparrow_variable"
          : "ai_suggested";
      return {
        variable: buildCustomVariableFromLLM(v),
        source,
        // Prefer the LLM's reason; fall back to the SS description for
        // SS-sourced variables that the LLM didn't justify.
        reason: v.reason ?? ssMatch?.description ?? undefined,
        alreadyAdded: existingIds.has(v.apiIdentifier),
      };
    });

    // BACKSTOP: SS variables the LLM didn't enrich. We previously
    // surfaced these with "Sample value A / B" placeholders, which the
    // user (rightly) flagged as low-effort filler. New behaviour: skip
    // them entirely from the suggestion list. The user can still see
    // them in the SS workspace and add manually if needed. If a future
    // pass wants to surface them, we should re-prompt the LLM to enrich
    // them rather than ship placeholders.
    const enrichedLower = new Set(
      llmVarSuggestions.map((v) => v.variable.apiIdentifier.toLowerCase()),
    );
    const ssMissingFromLLM = ssVariables.filter(
      (v) => !enrichedLower.has(v.name.toLowerCase()),
    );
    // If any SS variables were missed, surface as a soft warning rather
    // than padding the list with placeholders.
    const additionalWarnings: string[] = [];
    if (ssMissingFromLLM.length > 0) {
      additionalWarnings.push(
        `${ssMissingFromLLM.length} SurveySparrow variable${ssMissingFromLLM.length === 1 ? "" : "s"} weren't enriched (${ssMissingFromLLM.slice(0, 3).map((v) => v.name).join(", ")}${ssMissingFromLLM.length > 3 ? "…" : ""}). Add them manually in the Custom Variables section if you need them.`,
      );
    }

    return {
      context: llmOutput.context,
      themes,
      personaDistribution: distributionForShape(sentimentShape),
      variables: llmVarSuggestions,
      // Preserve the user's existing responseCount when we suggest a
      // time window — only the from/to/pattern flip.
      timing: {
        ...timingForSurveyType(survey.survey_type, draft.timeRange.responseCount),
      },
      warnings: [...(llmOutput.warnings ?? []), ...additionalWarnings],
    };
  }, [llmOutput, ssVariables, sentimentShape, draft.customVariables, draft.timeRange.responseCount, survey]);

  // ---- Apply: write only the toggled sections into the draft ----
  function handleApply() {
    if (!suggestion) return;
    setDraft((d) => {
      if (toggles.context) d.useCase = suggestion.context;
      if (toggles.themes) d.themes = suggestion.themes;
      if (toggles.personaDistribution) d.personaDistribution = suggestion.personaDistribution;
      if (toggles.timing) d.timeRange = suggestion.timing;
      // Variables — additive merge, skip duplicates. apiIdentifier is
      // unique across AI- and SS-sourced suggestions, so the toggle key
      // is just the identifier (no more "ss:" prefix).
      const seen = new Set(d.customVariables.map((v) => v.apiIdentifier));
      for (const sug of suggestion.variables) {
        if (!variablesToAdd.has(sug.variable.apiIdentifier)) continue;
        if (seen.has(sug.variable.apiIdentifier)) continue;
        d.customVariables.push(sug.variable);
        seen.add(sug.variable.apiIdentifier);
      }
    });
    const sections: string[] = [];
    if (toggles.context) sections.push("context");
    if (toggles.themes) sections.push(`${suggestion.themes.length} themes`);
    if (toggles.personaDistribution) sections.push("distribution");
    if (toggles.timing) sections.push("timing");
    const variableCount = variablesToAdd.size;
    if (variableCount > 0) sections.push(`${variableCount} variable${variableCount === 1 ? "" : "s"}`);
    toast.success(`Applied ${sections.join(" · ")}.`);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden p-0">
        <div className="flex max-h-[85vh] flex-col">
          <DialogHeader className="border-b px-6 pt-6 pb-4">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Setup Assistant
            </DialogTitle>
            <DialogDescription>
              Generate a tailored use case, themes, persona distribution, and custom
              variables based on your company + the selected survey. Nothing is applied
              until you click <strong>Apply selected</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {blockingError ? (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Not ready yet</AlertTitle>
                <AlertDescription>{blockingError}</AlertDescription>
              </Alert>
            ) : step === "inputs" ? (
              <InputsStep
                companyName={companyName}
                setCompanyName={setCompanyName}
                companyWebsite={companyWebsite}
                setCompanyWebsite={setCompanyWebsite}
                sentimentShape={sentimentShape}
                setSentimentShape={setSentimentShape}
                notes={notes}
                setNotes={setNotes}
                surveyName={survey?.name ?? ""}
                surveyType={survey?.survey_type ?? ""}
                costEstimate={setupCostEstimate}
                responseModelLabel={getModel(llmSetup.responseModel)?.label ?? llmSetup.responseModel}
              />
            ) : step === "loading" ? (
              <LoadingStep
                companyName={companyName}
                providerSupportsSearch={llmSetup.provider === "anthropic"}
              />
            ) : step === "error" ? (
              <ErrorStep message={errorMessage ?? "Unknown error"} onRetry={() => setStep("inputs")} />
            ) : (
              suggestion && (
                <PreviewStep
                  suggestion={suggestion}
                  toggles={toggles}
                  setToggles={setToggles}
                  variablesToAdd={variablesToAdd}
                  setVariablesToAdd={setVariablesToAdd}
                  draftHasContext={Boolean(draft.useCase)}
                  draftHasThemes={draft.themes.length > 0}
                />
              )
            )}
          </div>

          <DialogFooter className="border-t bg-muted/30 px-6 py-3">
            {!blockingError && step === "inputs" && (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button onClick={handleGenerate} disabled={!companyName.trim()} className="gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate brief
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {!blockingError && step === "loading" && (
              <Button variant="ghost" disabled>Working…</Button>
            )}
            {!blockingError && step === "preview" && suggestion && (
              <>
                <Button variant="ghost" onClick={() => setStep("inputs")} className="gap-1.5">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Tweak inputs
                </Button>
                <Button onClick={handleApply} className="gap-1.5">
                  <Check className="h-3.5 w-3.5" />
                  Apply selected
                </Button>
              </>
            )}
            {!blockingError && step === "error" && (
              <Button onClick={() => setStep("inputs")}>Try again</Button>
            )}
            {blockingError && (
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Inputs
// ---------------------------------------------------------------------------

interface InputsStepProps {
  companyName: string;
  setCompanyName: (v: string) => void;
  companyWebsite: string;
  setCompanyWebsite: (v: string) => void;
  sentimentShape: SentimentShape;
  setSentimentShape: (v: SentimentShape) => void;
  notes: string;
  setNotes: (v: string) => void;
  surveyName: string;
  surveyType: string;
  /** Pre-run cost estimate from the parent. The block renders only when
   *  pricing is known; otherwise we show a soft "Pricing unavailable" note. */
  costEstimate: AiSetupCostEstimate;
  /** Human-readable name for the model the setup assistant will use
   *  (e.g. "Claude Haiku 4.5"). Surfaces in the estimate block. */
  responseModelLabel: string;
}

function InputsStep(p: InputsStepProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Generating for:
        </div>
        <div className="mt-0.5 font-medium">{p.surveyName || "(no survey)"}</div>
        {p.surveyType && (
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {p.surveyType}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="setup-company">
            <span className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />Company name</span>
          </Label>
          <Input
            id="setup-company"
            value={p.companyName}
            onChange={(e) => p.setCompanyName(e.target.value)}
            placeholder="e.g. Nexora Living"
            maxLength={80}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-website">
            <span className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" />Company website (optional)</span>
          </Label>
          <Input
            id="setup-website"
            value={p.companyWebsite}
            onChange={(e) => p.setCompanyWebsite(e.target.value)}
            placeholder="nexoraliving.com"
            maxLength={120}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Demo sentiment shape</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {SENTIMENT_SHAPES.map((s) => {
            const active = p.sentimentShape === s.id;
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => p.setSentimentShape(s.id)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:bg-muted/60",
                )}
              >
                <div className="flex items-center justify-between text-sm font-medium">
                  {s.label}
                  {active && <CircleCheck className="h-4 w-4 text-primary" />}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{s.description}</div>
                <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.distribution.promoter}% / {s.distribution.passive}% / {s.distribution.detractor}%
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="setup-notes">Notes (optional)</Label>
        <Textarea
          id="setup-notes"
          value={p.notes}
          onChange={(e) => p.setNotes(e.target.value)}
          placeholder="What should this demo emphasise? Specific products, regions, customer segments, or pain points?"
          rows={3}
          maxLength={500}
          className="resize-none"
        />
        <div className="text-[10px] text-muted-foreground">
          {p.notes.length}/500
        </div>
      </div>

      {/* Pre-run cost estimate (8e). Compact, sits at the bottom of the
          inputs step so the user sees the cost just before clicking
          "Generate brief". Falls back to "Pricing unavailable" when the
          response model isn't in MODEL_PRICING. */}
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-foreground">Estimated AI setup cost</span>
          <span className="font-mono tabular-nums">
            {p.costEstimate.pricingUnavailable || p.costEstimate.estimatedCost == null
              ? "Pricing unavailable"
              : `~${formatAiSetupCost(p.costEstimate.estimatedCost)}`}
          </span>
        </div>
        <div className="mt-0.5">
          Uses your selected response model · <span className="font-medium">{p.responseModelLabel}</span>
        </div>
        <div className="mt-0.5 opacity-80">
          Usually under $0.02 — covers the single assistant call before persona + response generation. The Configure cost panel covers the full pipeline separately.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Loading
// ---------------------------------------------------------------------------

function LoadingStep({ companyName, providerSupportsSearch }: { companyName: string; providerSupportsSearch: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <div className="text-sm font-medium">Generating brief for {companyName}…</div>
      <div className="max-w-sm text-xs text-muted-foreground">
        {providerSupportsSearch
          ? "Researching the company on the web, fetching SurveySparrow variables, and asking your LLM for tailored context, themes, and custom variables."
          : "Reading the company homepage, fetching SurveySparrow variables, and asking your LLM for tailored context, themes, and custom variables."}
      </div>
      {providerSupportsSearch && (
        <div className="text-[10px] text-muted-foreground/80">
          (web search can take 30–60s — Anthropic's research tool is doing the legwork)
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Preview
// ---------------------------------------------------------------------------

interface PreviewStepProps {
  suggestion: SetupAssistantSuggestion;
  toggles: ApplyToggles;
  setToggles: (t: ApplyToggles) => void;
  variablesToAdd: Set<string>;
  setVariablesToAdd: (s: Set<string>) => void;
  draftHasContext: boolean;
  draftHasThemes: boolean;
}

function PreviewStep(p: PreviewStepProps) {
  function toggle<K extends keyof ApplyToggles>(key: K) {
    p.setToggles({ ...p.toggles, [key]: !p.toggles[key] });
  }
  function toggleVariable(key: string) {
    const next = new Set(p.variablesToAdd);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    p.setVariablesToAdd(next);
  }
  return (
    <div className="space-y-4">
      {p.suggestion.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Notes from the assistant</AlertTitle>
          <AlertDescription className="space-y-0.5 text-xs">
            {p.suggestion.warnings.map((w, i) => <div key={i}>· {w}</div>)}
          </AlertDescription>
        </Alert>
      )}

      <SectionCard
        title="Use case context"
        applied={p.toggles.context}
        onToggle={() => toggle("context")}
        replaceWarning={p.draftHasContext}
      >
        <p className="whitespace-pre-line text-sm leading-relaxed">{p.suggestion.context}</p>
      </SectionCard>

      <SectionCard
        title={`Themes (${p.suggestion.themes.length})`}
        applied={p.toggles.themes}
        onToggle={() => toggle("themes")}
        replaceWarning={p.draftHasThemes}
      >
        <div className="flex flex-wrap gap-1.5">
          {p.suggestion.themes.map((t) => (
            <Badge key={t.id} variant="secondary" className="font-normal">
              {t.label}
              <span className="ml-1.5 text-[10px] text-muted-foreground">w {t.weight}</span>
            </Badge>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Persona distribution"
        applied={p.toggles.personaDistribution}
        onToggle={() => toggle("personaDistribution")}
      >
        <div className="grid grid-cols-3 gap-3 text-center text-xs">
          <DistTile label="Promoters" value={p.suggestion.personaDistribution.promoter} tone="success" />
          <DistTile label="Passives" value={p.suggestion.personaDistribution.passive} tone="neutral" />
          <DistTile label="Detractors" value={p.suggestion.personaDistribution.detractor} tone="danger" />
        </div>
      </SectionCard>

      <SectionCard
        title="Response timing"
        applied={p.toggles.timing}
        onToggle={() => toggle("timing")}
      >
        <p className="text-xs text-muted-foreground">
          {new Date(p.suggestion.timing.from).toLocaleDateString()} →{" "}
          {new Date(p.suggestion.timing.to).toLocaleDateString()} · {p.suggestion.timing.pattern} · business hours
        </p>
      </SectionCard>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Custom variables ({p.suggestion.variables.length} suggested)</h4>
          <span className="text-[10px] text-muted-foreground">
            Tick the ones you want — duplicates are skipped.
          </span>
        </div>
        {p.suggestion.variables.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            No variables suggested.
          </div>
        ) : (
          <div className="space-y-1.5">
            {p.suggestion.variables.map((v) => {
              // Toggle key is just the apiIdentifier — no more "ss:"
              // prefix since AI and SS variables share one unique
              // identifier namespace after 8d.
              const key = v.variable.apiIdentifier;
              const checked = p.variablesToAdd.has(key);
              return (
                <VariableRow
                  key={key}
                  suggestion={v}
                  checked={checked}
                  onToggle={() => toggleVariable(key)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  applied,
  onToggle,
  children,
  replaceWarning,
}: {
  title: string;
  applied: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  replaceWarning?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 transition-colors",
        applied ? "border-primary/40 bg-primary/5" : "border-border bg-card",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold">{title}</h4>
          {replaceWarning && applied && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              Will replace existing
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded border transition-colors",
            applied
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-muted/40 hover:bg-muted",
          )}
          aria-label={applied ? "Don't apply" : "Apply this section"}
          aria-pressed={applied}
        >
          {applied && <Check className="h-3 w-3" />}
        </button>
      </div>
      {children}
    </div>
  );
}

function DistTile({ label, value, tone }: { label: string; value: number; tone: "success" | "neutral" | "danger" }) {
  const cls =
    tone === "success" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : tone === "danger" ? "bg-red-500/15 text-red-700 dark:text-red-300"
    : "bg-muted text-foreground";
  return (
    <div className={cn("rounded-md px-2 py-2", cls)}>
      <div className="font-mono text-lg font-semibold tabular-nums">{value}%</div>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

function VariableRow({
  suggestion,
  checked,
  onToggle,
}: {
  suggestion: VariableSuggestion;
  checked: boolean;
  onToggle: () => void;
}) {
  const v = suggestion.variable;
  const optionsText =
    v.values.kind === "string"
      ? v.values.config.options.slice(0, 3).map((o) => o.text).join(" · ")
      : "";
  return (
    <button
      type="button"
      onClick={suggestion.alreadyAdded ? undefined : onToggle}
      disabled={suggestion.alreadyAdded}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        suggestion.alreadyAdded
          ? "cursor-not-allowed border-border bg-muted/30 opacity-70"
          : checked
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-card hover:bg-muted/40",
      )}
      aria-pressed={!suggestion.alreadyAdded && checked}
    >
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-muted/40">
        {suggestion.alreadyAdded ? (
          <Check className="h-3 w-3 text-muted-foreground" />
        ) : checked ? (
          <Check className="h-3 w-3 text-primary" />
        ) : (
          <Plus className="h-3 w-3 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{v.label}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {v.apiIdentifier}
          </span>
          {suggestion.source === "surveysparrow_variable" ? (
            <span
              className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
              title="Exists in your SurveySparrow workspace. Values shown were enriched by the LLM for this demo — only the definition is reused."
            >
              SS · AI-enriched
            </span>
          ) : (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
              AI
            </span>
          )}
          {suggestion.alreadyAdded && (
            <span className="ml-auto text-[10px] text-muted-foreground">already added</span>
          )}
        </div>
        {optionsText && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{optionsText}</div>
        )}
        {suggestion.reason && (
          <div className="mt-0.5 text-[11px] italic text-muted-foreground/80">{suggestion.reason}</div>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

function ErrorStep({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div className="text-sm font-medium">Assistant failed</div>
      <div className="max-w-md text-xs text-muted-foreground">{message}</div>
      <Button size="sm" variant="outline" onClick={onRetry} className="mt-2">
        Adjust inputs
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers — build CustomVariable instances from LLM / SS suggestion shapes.
// ---------------------------------------------------------------------------

function buildCustomVariableFromLLM(v: SetupAssistantLLMOutput["customVariables"][number]): CustomVariable {
  const t = v.type ?? "STRING";
  // NUMBER — range or static, with optional decimals.
  if (t === "NUMBER" && v.numberConfig) {
    const c = v.numberConfig;
    return {
      id: crypto.randomUUID(),
      label: v.label,
      apiIdentifier: v.apiIdentifier,
      type: "NUMBER",
      values: {
        kind: "number",
        config: {
          mode: c.mode === "static" ? "static" : "range",
          min: c.min,
          max: c.max,
          staticValue: c.staticValue,
          allowDecimals: c.allowDecimals === true,
          ...(c.decimalPlaces ? { decimalPlaces: c.decimalPlaces } : {}),
        },
      },
    };
  }
  // DATE — relative or absolute range. epoch-ms is the storage unit (matches
  // DateValueConfig); the validator already coerced YYYY-MM-DD strings.
  if (t === "DATE" && v.dateConfig) {
    const c = v.dateConfig;
    return {
      id: crypto.randomUUID(),
      label: v.label,
      apiIdentifier: v.apiIdentifier,
      type: "DATE",
      values: {
        kind: "date",
        config: {
          mode: c.mode === "range" ? "range" : "relative",
          relativeDays: c.relativeDays,
          start: typeof c.start === "number" ? c.start : undefined,
          end: typeof c.end === "number" ? c.end : undefined,
        },
      },
    };
  }
  // STRING fallback (also covers the explicit STRING case). Defensive
  // `?? []` because the LLM output type now marks `options` as optional —
  // any NUMBER/DATE entry that fell through here would have no options.
  return {
    id: crypto.randomUUID(),
    label: v.label,
    apiIdentifier: v.apiIdentifier,
    type: "STRING",
    values: {
      kind: "string",
      config: {
        mode: "options",
        options: (v.options ?? []).map((o) => ({ text: o.text, weight: o.weight })),
      },
    },
  };
}

// `buildCustomVariableFromSS` + `titleCase` helpers were retired in 8d.
// SS variables now come back from the LLM already enriched with real
// option values, so we no longer need to fabricate "Sample value A / B"
// placeholders. If the LLM ever fails to enrich a given SS variable, it
// surfaces as a soft warning instead of getting padded with fillers.
