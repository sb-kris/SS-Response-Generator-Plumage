"use client";

import { useWizardStore, type WizardStep } from "@/store/wizard-store";
import { useSurveyStore } from "@/store/survey-store";
import { usePersonasStore } from "@/store/personas-store";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, Lock } from "lucide-react";

interface StepDef {
  id: WizardStep;
  title: string;
  hint: string;
  // True if this step is unlocked given the current data state.
  isUnlocked: (state: {
    surveyOk: boolean;
    questionsOk: boolean;
    personasOk: boolean;
  }) => boolean;
  /** Future phases — show a Lock icon and a tooltip hint. */
  futurePhase?: number;
}

const STEPS: StepDef[] = [
  {
    id: 1,
    title: "Select survey",
    hint: "Pick the SurveySparrow survey to generate responses for.",
    isUnlocked: () => true,
  },
  {
    id: 2,
    title: "Configure",
    hint: "Set context, themes, persona mix, language mix, and per-question controls.",
    isUnlocked: ({ surveyOk, questionsOk }) => surveyOk && questionsOk,
  },
  {
    id: 3,
    title: "Synthesize personas",
    hint: "Generate persona profiles before producing responses.",
    isUnlocked: ({ surveyOk, questionsOk }) => surveyOk && questionsOk,
  },
  {
    id: 4,
    title: "Generate & push",
    hint: "Generate responses, preview them, then push to SurveySparrow.",
    isUnlocked: ({ personasOk }) => personasOk,
  },
];

export function StepNav() {
  const currentStep = useWizardStore((s) => s.currentStep);
  const setStep = useWizardStore((s) => s.setStep);
  const surveyOk = useSurveyStore((s) => s.selectedSurveyId !== null);
  const questionsOk = useSurveyStore((s) => s.questions.status === "ok");
  const personasOk = usePersonasStore(
    (s) => s.status === "complete" && s.personas.length > 0,
  );

  return (
    <ol className="flex w-full items-center gap-1 overflow-x-auto rounded-lg border bg-card/50 p-2 text-sm">
      {STEPS.map((step, idx) => {
        const isCurrent = currentStep === step.id;
        const isComplete = step.id < currentStep;
        const unlocked = step.isUnlocked({ surveyOk, questionsOk, personasOk });
        const navigable = unlocked && !isCurrent;

        const button = (
          <button
            type="button"
            disabled={!navigable}
            onClick={() => navigable && setStep(step.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors",
              isCurrent && "bg-accent text-accent-foreground",
              !isCurrent && navigable && "hover:bg-accent/50",
              !unlocked && "cursor-not-allowed opacity-60",
            )}
            aria-current={isCurrent ? "step" : undefined}
          >
            <StepIndicator
              n={idx + 1}
              isCurrent={isCurrent}
              isComplete={isComplete}
              isLocked={!unlocked}
            />
            <div className="min-w-0">
              <div
                className={cn(
                  "text-xs font-medium uppercase tracking-wide",
                  isCurrent
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                Step {idx + 1}
              </div>
              <div className="truncate text-sm font-medium">{step.title}</div>
            </div>
          </button>
        );

        const wrapped =
          !unlocked || !isCurrent ? (
            <Tooltip key={step.id}>
              <TooltipTrigger asChild>
                <li className="flex-1 min-w-[160px]">{button}</li>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                {step.futurePhase ? (
                  <span>Coming soon.</span>
                ) : !unlocked ? (
                  <span>Complete the previous step first.</span>
                ) : (
                  step.hint
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            <li key={step.id} className="flex-1 min-w-[160px]">
              {button}
            </li>
          );

        return wrapped;
      })}
    </ol>
  );
}

function StepIndicator({
  n,
  isCurrent,
  isComplete,
  isLocked,
}: {
  n: number;
  isCurrent: boolean;
  isComplete: boolean;
  isLocked: boolean;
}) {
  return (
    <div
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        isComplete && "border-success bg-success text-success-foreground",
        !isComplete &&
          isCurrent &&
          "border-primary bg-primary text-primary-foreground",
        !isComplete && !isCurrent && !isLocked && "border-input bg-background text-muted-foreground",
        isLocked && "border-input bg-muted text-muted-foreground",
      )}
    >
      {isComplete ? (
        <Check className="h-4 w-4" />
      ) : isLocked ? (
        <Lock className="h-3.5 w-3.5" />
      ) : (
        n
      )}
    </div>
  );
}
