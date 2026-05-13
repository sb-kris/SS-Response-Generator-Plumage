"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useWizardStore } from "@/store/wizard-store";
import { SurveySelector } from "@/components/generate/SurveySelector";
import { QuestionPreview } from "@/components/generate/QuestionPreview";
import { StepNav } from "@/components/generate/StepNav";
import { ConfigureStep } from "@/components/generate/configure/ConfigureStep";
import { SynthesizeStep } from "@/components/generate/synthesize/SynthesizeStep";
import { GenerateAndPushStep } from "@/components/generate/generate/GenerateAndPushStep";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ArrowRight } from "lucide-react";

export default function GeneratePage() {
  const ssStatus = useSetupStore((s) => s.ssConnection.status);
  const llmStatus = useSetupStore((s) => s.llmConnection.status);
  const ssOk = ssStatus === "ok";
  const llmOk = llmStatus === "ok";

  const currentStep = useWizardStore((s) => s.currentStep);
  const setStep = useWizardStore((s) => s.setStep);

  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questionsStatus = useSurveyStore((s) => s.questions.status);
  const step1Complete = selectedSurveyId !== null && questionsStatus === "ok";

  // Defensive: if the user lands on /generate while step 2/3/4 is active but
  // step 1 isn't actually complete yet (e.g. fresh browser, sessionStorage
  // restored a wizard step but the survey hasn't loaded yet), reset to 1.
  useEffect(() => {
    if (currentStep > 1 && !step1Complete) {
      setStep(1);
    }
  }, [currentStep, step1Complete, setStep]);

  if (!ssOk || !llmOk) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Generate</h1>
          <p className="text-muted-foreground">
            Pick a survey, configure the demo context, and generate persona-driven
            responses.
          </p>
        </header>

        <Alert variant="warning">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Connect your accounts first.</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {!ssOk && !llmOk
                ? "Both SurveySparrow and your LLM provider need a successful Test Connection before you can generate responses."
                : !ssOk
                  ? "SurveySparrow isn't connected yet. Test the connection on the setup screen."
                  : "Your LLM provider isn't connected yet. Test the connection on the setup screen."}
            </p>
            <Button asChild size="sm" variant="outline" className="bg-background">
              <Link href="/">Go to setup</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Generate</h1>
        <p className="text-muted-foreground">
          Walk through the steps below. Your in-progress configuration is
          remembered for this tab and saved profiles persist across sessions.
        </p>
      </header>

      <StepNav />

      {currentStep === 1 && (
        <div className="space-y-6">
          <SurveySelector />
          <QuestionPreview />

          {step1Complete && (
            <div className="flex justify-end">
              <Button onClick={() => setStep(2)}>
                Continue to configure
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {currentStep === 2 && <ConfigureStep />}
      {currentStep === 3 && <SynthesizeStep />}
      {currentStep === 4 && <GenerateAndPushStep />}
    </div>
  );
}
