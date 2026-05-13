"use client";

import { useEffect, useState } from "react";
import { useSurveyStore } from "@/store/survey-store";
import { useWizardStore } from "@/store/wizard-store";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  SectionAnchorRail,
  type AnchorDef,
} from "./SectionAnchorRail";
import { ContextSection } from "./ContextSection";
import { ThemesSection } from "./ThemesSection";
import { PersonasSection } from "./PersonasSection";
import { LanguagesSection } from "./LanguagesSection";
import { CountryFilterSection } from "./CountryFilterSection";
import { CustomVariablesSection } from "./CustomVariablesSection";
import { SystemMetadataSection } from "./SystemMetadataSection";
import { TimingSection } from "./TimingSection";
import { ProfileBar } from "./ProfileBar";
import { CostEstimatorPanel } from "./CostEstimatorPanel";

const ANCHORS: AnchorDef[] = [
  { id: "context", label: "Context" },
  { id: "themes", label: "Themes" },
  { id: "personas", label: "Personas" },
  { id: "language", label: "Languages" },
  { id: "countries", label: "Countries" },
  { id: "variables", label: "Custom variables" },
  { id: "metadata", label: "System metadata" },
  { id: "timing", label: "Timing" },
];

export function ConfigureStep() {
  const setStep = useWizardStore((s) => s.setStep);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurvey = surveys?.find((s) => s.id === selectedSurveyId) ?? null;

  // Read the URL hash on mount so deep links from /profiles or external links
  // (e.g. /generate#themes once 3b lands) jump to the right section.
  const [initialAnchor, setInitialAnchor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (hash && ANCHORS.some((a) => a.id === hash)) {
      setInitialAnchor(hash);
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* Selected-survey breadcrumb */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep(1)}
            className="h-8 -ml-2 gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Change survey
          </Button>
          {selectedSurvey && (
            <span className="text-muted-foreground">
              · Configuring{" "}
              <span className="font-medium text-foreground">{selectedSurvey.name}</span>
            </span>
          )}
        </div>
      </div>

      {/* Profile management bar */}
      <ProfileBar />

      {/* Two-pane configuration layout */}
      <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)_280px]">
        {/* Left rail */}
        <div className="hidden lg:block">
          <SectionAnchorRail anchors={ANCHORS} initialAnchor={initialAnchor} />
        </div>

        {/* Sections */}
        <div className="space-y-6 min-w-0">
          <ContextSection />
          <ThemesSection />
          <PersonasSection />
          <LanguagesSection />
          <CountryFilterSection />
          <CustomVariablesSection />
          <SystemMetadataSection />
          <TimingSection />

          {/* Advance to Phase 4 */}
          <div className="flex justify-end pt-2">
            <Button onClick={() => setStep(3)} className="gap-1.5">
              Continue to synthesize personas
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Sticky cost panel (collapses to a bottom row on smaller screens) */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <CostEstimatorPanel />
        </div>
      </div>
    </div>
  );
}
