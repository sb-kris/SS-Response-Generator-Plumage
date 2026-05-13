"use client";

import { useState } from "react";
import { useResponsesStore } from "@/store/responses-store";
import { useWizardStore } from "@/store/wizard-store";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useGenerateResponses } from "./useGenerateResponses";
import { usePushResponses } from "./usePushResponses";
import { useSleepResilience } from "./useSleepResilience";
import { PreGenerationCard } from "./PreGenerationCard";
import { GeneratingCard } from "./GeneratingCard";
import { BasicPreviewCard } from "./BasicPreviewCard";
import { PushToSurveySparrowCard } from "./PushToSurveySparrowCard";
import { RecoveryCard } from "./RecoveryCard";
import { DebugPanel } from "./DebugPanel";

// Step 4 — Generate & Push.
//
//   State A: Pre-generation summary    ← PreGenerationCard
//   State B: Generating responses      ← GeneratingCard
//   State C: Preview                   ← BasicPreviewCard
//   State D: Pushing to SS             ← PushToSurveySparrowCard (running)
//   State E: Push complete             ← PushToSurveySparrowCard (complete)
//
// CRITICAL: both hooks are called HERE (the parent) so their AbortControllers
// survive card transitions — avoids the instant-cancel bug from Phase 4.
//
// Push-view navigation:
//   - "Push to SurveySparrow" button sets `inPushView = true`.
//   - "Back to preview" sets `inPushView = false` (only allowed when not running).
//   - If a push is already running or complete when the user clicks Push, they
//     land in the push card immediately without restarting the job.

export function GenerateAndPushStep() {
  const status = useResponsesStore((s) => s.status);
  const responses = useResponsesStore((s) => s.responses);
  const pushStatus = useResponsesStore((s) => s.pushStatus);
  const skipPreview = useResponsesStore((s) => s.skipPreview);
  const setStep = useWizardStore((s) => s.setStep);

  const gen = useGenerateResponses();
  const pushHook = usePushResponses();

  // Hold a screen wake lock while any LLM call is in flight (generation OR push).
  // The hook also shows a tab-hidden toast warning. See useSleepResilience.ts for
  // the localhost laptop-sleep limitation note.
  useSleepResilience(status === "running" || pushStatus === "running");

  // Local flag: user has navigated into the push view.
  // Separate from `pushStatus` so "Push to SurveySparrow" navigates to the
  // push card even when pushStatus is still "idle" (user confirms before push).
  const [inPushView, setInPushView] = useState(false);

  const handleEnterPush = () => {
    setInPushView(true);
  };

  const handleBackToPreview = () => {
    if (pushStatus === "running") return; // can't go back while pushing
    setInPushView(false);
    // Don't reset push results — the user may want to review them later.
    // Only reset if they explicitly choose "Retry" from PushCard.
  };

  const showPushCard =
    inPushView ||
    pushStatus === "running" ||
    // Skip-preview: jump straight to push after generation finishes.
    (status === "complete" && responses.length > 0 && skipPreview && pushStatus === "idle");

  const showPreview = status === "complete" && responses.length > 0 && !showPushCard;

  // Phase 7a — show recovery card when there are partial responses and the
  // run isn't running or complete (interrupted, errored, or aborted).
  // Hide once the user picks "Use partial" (status flips to complete) or
  // "Discard" (responses array empties).
  const showRecovery =
    responses.length > 0 &&
    status !== "running" &&
    status !== "complete";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStep(3)}
          className="h-8 -ml-2 gap-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to personas
        </Button>
      </div>

      {status === "running" ? (
        <GeneratingCard gen={gen} />
      ) : showRecovery ? (
        <RecoveryCard gen={gen} />
      ) : showPushCard ? (
        <PushToSurveySparrowCard
          pushHook={pushHook}
          onBack={handleBackToPreview}
          autoStart={skipPreview && pushStatus === "idle"}
        />
      ) : showPreview ? (
        <BasicPreviewCard gen={gen} onPush={handleEnterPush} />
      ) : (
        <PreGenerationCard gen={gen} />
      )}

      {/* Phase 7d — live observability panel. Persists across all state
          transitions (running → recovery → preview → push) so debug events
          and post-mortem metrics are always accessible. Hidden when empty. */}
      <DebugPanel />
    </div>
  );
}
