"use client";

import { useEffect, useState } from "react";
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
import { Loader2, ShieldAlert, X } from "lucide-react";
import type { GenerateResponsesHookState } from "./useGenerateResponses";
import { RotatingLoadingMessage } from "@/components/ui/RotatingLoadingMessage";
import { RESPONSE_GENERATION_MESSAGES } from "@/lib/copy/loading-messages";
import { GenerationTheater } from "./GenerationTheater";

// State B — generating responses.
//
// Per the prompt design, we stream PROGRESS COUNT only — not response
// content. The "Latest persona" line shows just the most-recently-completed
// name, rotating as new ones arrive. No streamed answer text. This keeps
// the UI fast and avoids leaking partially-generated output that might
// confuse SEs.

interface Props {
  gen: GenerateResponsesHookState;
}

export function GeneratingCard({ gen }: Props) {
  const { cancel } = gen;
  const progress = useResponsesStore((s) => s.progress);
  const warnings = progress.warnings;

  const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  const eta = useEta(progress);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <CardTitle>Generating responses…</CardTitle>
        </div>
        <CardDescription>
          <RotatingLoadingMessage pool={RESPONSE_GENERATION_MESSAGES} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">
              Generated{" "}
              <span className="font-mono tabular-nums">
                {progress.completed.toLocaleString()}
              </span>
              {" / "}
              <span className="font-mono tabular-nums">
                {progress.total.toLocaleString()}
              </span>{" "}
              responses
            </span>
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
          <p className="text-[11px] text-muted-foreground">
            Keep this tab in the foreground for best speed. Closing your laptop lid or
            putting the machine to sleep will interrupt generation — Plumage can resume
            from where it stopped when you come back.
          </p>
        </div>

        {/* Live event feed — the storytelling layer. Sits below the
            progress bar so at-a-glance progress (%) and moment-to-moment
            detail (which persona, what rating) are both available. */}
        <GenerationTheater />

        {progress.latestPersonaName && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Latest persona: </span>
            <span className="font-medium">{progress.latestPersonaName}</span>
          </div>
        )}

        {warnings.length > 0 && (
          <Alert variant="warning">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>
              {warnings.length} persona{warnings.length === 1 ? "" : "s"} required retries (recovered)
            </AlertTitle>
            <AlertDescription className="space-y-1">
              {warnings.slice(-3).map((w, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">{w.personaName}</span>: {w.message}
                </div>
              ))}
              {warnings.length > 3 && (
                <div className="text-[10px] text-muted-foreground">
                  (+{warnings.length - 3} earlier)
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div>
          <Button variant="outline" size="sm" onClick={cancel} className="gap-1.5">
            <X className="h-3.5 w-3.5" />
            Cancel generation
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ETA — empirical extrapolation from observed throughput, falling back to
// the cost-estimator's prediction until the first persona completes.
// ---------------------------------------------------------------------------

function useEta(progress: {
  completed: number;
  total: number;
  startedAt: number | null;
  estimatedSeconds: number | null;
}): string | null {
  const [, force] = useState(0);
  // Tick every 1s so the ETA actually counts down between progress events.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!progress.startedAt) return null;
  const elapsed = (Date.now() - progress.startedAt) / 1000;

  if (progress.completed > 0 && progress.total > 0) {
    const remaining =
      (elapsed / progress.completed) * (progress.total - progress.completed);
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
