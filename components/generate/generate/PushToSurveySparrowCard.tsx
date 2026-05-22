"use client";

import { useEffect } from "react";
import { useResponsesStore } from "@/store/responses-store";
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
  CheckCircle2,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import type { PushResponsesHookState } from "./usePushResponses";
import { DebugPanel } from "./DebugPanel";
import { RotatingLoadingMessage } from "@/components/ui/RotatingLoadingMessage";
import { PUSH_MESSAGES } from "@/lib/copy/loading-messages";
import { celebrateFirstPush, replayCelebration } from "@/lib/effects/celebrate";
import { playFailureCue } from "@/lib/effects/sound-effects";
import { SpeakerButton } from "@/components/shared/SpeakerButton";

// Phase 5c — States D (pushing) and E (push complete / partial failed).
//
// Both states live in one component because the data shown in E is a
// summary of what happened in D; keeping them together avoids duplicating
// the results block.

interface Props {
  pushHook: PushResponsesHookState;
  onBack: () => void;
  autoStart?: boolean;
}

export function PushToSurveySparrowCard({ pushHook, onBack, autoStart }: Props) {
  const pushStatus = useResponsesStore((s) => s.pushStatus);
  const pushProgress = useResponsesStore((s) => s.pushProgress);
  const responses = useResponsesStore((s) => s.responses);
  const { push, pushAgain, cancel, canPush, reasonNotReady } = pushHook;

  // Auto-start push when skip-preview is active (signalled by the parent).
  useEffect(() => {
    if (autoStart && canPush) {
      void push();
    }
    // Only run once on mount — intentionally no deps on `push` reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-push celebration — fires once per session when a push completes
  // with zero failures. Module-level guard in celebrateFirstPush prevents
  // re-firing on subsequent successful pushes.
  useEffect(() => {
    if (pushStatus === "complete" && pushProgress.failed === 0 && pushProgress.pushed > 0) {
      void celebrateFirstPush();
    }
  }, [pushStatus, pushProgress.failed, pushProgress.pushed]);

  // Failure cue — fires once each time a push completes with any failures.
  // Distinct from celebration: we WANT this to fire every time (not session-
  // guarded) because each failed batch is a discrete event the user needs to
  // hear. Detached useEffect with the same trigger keys means changing
  // pushed counts can't accidentally double-fire — we only react to the
  // moment the status flips to "complete".
  useEffect(() => {
    if (pushStatus === "complete" && pushProgress.failed > 0) {
      void playFailureCue();
    }
  }, [pushStatus, pushProgress.failed]);

  const isRunning = pushStatus === "running";
  const isComplete = pushStatus === "complete";
  const pct =
    pushProgress.total > 0
      ? Math.round(((pushProgress.pushed + pushProgress.failed) / pushProgress.total) * 100)
      : 0;

  const failedResponses = responses.filter((r) => r.status === "failed");
  const pushedCount = responses.filter((r) => r.status === "pushed").length;
  // Responses still in "generated" after completion = were never attempted (cancelled).
  const remainingCount = responses.filter((r) => r.status === "generated").length;
  const wasCancelled = isComplete && remainingCount > 0;

  if (pushStatus === "idle") {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            <CardTitle>Push to SurveySparrow</CardTitle>
          </div>
          <CardDescription>
            {pushProgress.total > 0
              ? `Send ${responses.length.toLocaleString()} responses to your SurveySparrow survey.`
              : `Send ${responses.length.toLocaleString()} generated responses to SurveySparrow.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canPush && reasonNotReady && (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Can&apos;t push yet</AlertTitle>
              <AlertDescription>{reasonNotReady}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              onClick={() => void push()}
              disabled={!canPush}
              className="gap-2"
            >
              <Send className="h-4 w-4" />
              Push {responses.length.toLocaleString()} responses
            </Button>
            <Button variant="outline" size="lg" onClick={onBack} className="gap-2">
              Back to preview
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Organic shape on the celebratory state only — running and partial-fail
  // states keep the standard rectilinear card so they don't read as "done".
  const isSuccessComplete = isComplete && pushProgress.failed === 0;

  return (
    <Card className={isSuccessComplete ? "card-organic-static" : undefined}>
      <CardHeader>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : pushProgress.failed === 0 ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-amber-500" />
          )}
          <CardTitle>
            {isRunning
              ? "Pushing to SurveySparrow…"
              : pushProgress.failed === 0
                ? "All responses pushed"
                : `Push complete — ${pushProgress.failed} failed`}
          </CardTitle>
        </div>
        <CardDescription>
          {isRunning ? (
            <span className="flex flex-wrap items-baseline gap-x-2">
              <RotatingLoadingMessage pool={PUSH_MESSAGES} />
              <span className="text-xs opacity-70">
                {pushProgress.pushed + pushProgress.failed} of {pushProgress.total} sent — up to 3 in parallel.
              </span>
            </span>
          ) : (
            `${pushedCount.toLocaleString()} pushed · ${pushProgress.failed} failed`
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Progress bar */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium tabular-nums">
              {pushProgress.pushed + pushProgress.failed} / {pushProgress.total}
            </span>
            <span className="text-xs text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
            />
          </div>
          {pushProgress.failed > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {pushProgress.failed} failed so far
            </p>
          )}
        </div>

        {/* Failed response list (shown after completion) */}
        {isComplete && failedResponses.length > 0 && (
          <Alert variant="warning">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>
              {failedResponses.length} response{failedResponses.length === 1 ? "" : "s"} failed to push
            </AlertTitle>
            <AlertDescription className="space-y-1">
              {failedResponses.slice(0, 5).map((r) => (
                <div key={r.id} className="flex items-start gap-1.5 text-xs">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                  <span>
                    <span className="font-medium">{r.personaName}</span>
                    {r.errorMessage ? `: ${r.errorMessage}` : ""}
                  </span>
                </div>
              ))}
              {failedResponses.length > 5 && (
                <p className="text-[10px] text-muted-foreground">
                  +{failedResponses.length - 5} more
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Success banner */}
        {isComplete && failedResponses.length === 0 && (
          <Alert className="relative">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <AlertTitle className="pr-20">
              {pushedCount.toLocaleString()} responses are now in SurveySparrow
            </AlertTitle>
            <AlertDescription className="pr-20">
              They will appear in your survey&apos;s Responses tab within a few seconds.
            </AlertDescription>
            {/* Replay celebration — animated speaker icon (webm) top-right.
                On click: re-fires confetti + celebration sound. Sized to
                fill the alert's right-edge negative space without crowding
                the title text. Vertically centered on the alert. */}
            <SpeakerButton
              onPlay={() => void replayCelebration()}
              label="Replay celebration sound"
              className="absolute right-3 top-1/2 h-14 w-14 -translate-y-1/2"
            />
          </Alert>
        )}

        <DebugPanel />

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {isRunning && (
            <>
              <Button variant="outline" size="sm" onClick={cancel} className="gap-1.5">
                <X className="h-3.5 w-3.5" />
                Cancel push
              </Button>
              {/* Back-to-preview while pushing — the push hook lives on the
                  parent and continues in the background, so the user can
                  inspect / verify responses without halting delivery. The
                  push card auto-returns via the Push button when they want
                  to watch progress again. */}
              <Button
                variant="outline"
                size="sm"
                onClick={onBack}
                className="gap-1.5"
                title="Push continues in the background. Click Push to return here."
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to preview
              </Button>
            </>
          )}
          {/* "Send remaining" — continues after a cancel (pushes all non-pushed). */}
          {isComplete && (wasCancelled || failedResponses.length > 0) && (
            <Button
              size="sm"
              onClick={() => void push()}
              className="gap-1.5"
            >
              <Send className="h-3.5 w-3.5" />
              {wasCancelled
                ? `Send remaining (${remainingCount + failedResponses.length})`
                : `Retry failed (${failedResponses.length})`}
            </Button>
          )}
          {/* "Push another copy" — re-pushes the entire response set even
              after a clean success. Two scenarios where this matters:
              (1) SS accepted the batch (202) but a silent downstream drop
                  meant some responses never landed — UI says "Pushed" but
                  the dashboard is missing data. One-click rescue.
              (2) The user genuinely wants duplicates for a stress demo. */}
          {isComplete && pushedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pushAgain()}
              className="gap-1.5"
              title="Resets every response and pushes the full set again."
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Push another copy
            </Button>
          )}
          {isComplete && (
            <Button variant="outline" size="sm" onClick={onBack} className="gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to preview
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
