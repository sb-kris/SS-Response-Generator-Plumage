"use client";

import { useEffect, useRef, useState } from "react";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { AlertTriangle, X, Zap } from "lucide-react";

/**
 * Sticky top-of-page banner that appears when either persona synthesis OR
 * response generation is running. Persists across navigation steps so SEs
 * know a run is live even if they switch tabs. Each new run resets the
 * dismissed state so the banner always shows at least once per operation.
 *
 * Also registers a `beforeunload` handler while visible so the browser
 * shows its native "Leave site?" dialog for tab-close / external navigation.
 */
export function GenerationRunningBanner() {
  const genStatus = useResponsesStore((s) => s.status);
  const genProgress = useResponsesStore((s) => s.progress);
  const synthStatus = usePersonasStore((s) => s.status);
  const synthProgress = usePersonasStore((s) => s.progress);

  const isGenerating = genStatus === "running";
  const isSynthesizing = synthStatus === "running";
  const isRunning = isGenerating || isSynthesizing;

  // Derive a "run key" that changes whenever a new operation starts.
  const genKey = genProgress.startedAt ?? 0;
  const synthKey = synthProgress.startedAt ?? 0;
  const runKey = isGenerating ? genKey : synthKey;

  const prevKeyRef = useRef(runKey);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (runKey !== prevKeyRef.current) {
      prevKeyRef.current = runKey;
      setDismissed(false);
    }
  }, [runKey]);

  // `beforeunload` — native dialog for tab-close / external navigation.
  useEffect(() => {
    if (!isRunning) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isRunning]);

  if (!isRunning || dismissed) return null;

  const { completed, total, latestPersonaName } = isGenerating
    ? { completed: genProgress.completed, total: genProgress.total, latestPersonaName: genProgress.latestPersonaName }
    : { completed: synthProgress.completed, total: synthProgress.total, latestPersonaName: "" };

  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const label = isGenerating ? "Response generation" : "Persona synthesis";

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative z-50 border-b border-amber-400/40 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/60"
    >
      {/* Progress fill */}
      <div
        className="absolute inset-x-0 top-0 h-0.5 bg-amber-400 transition-all duration-500 dark:bg-amber-500"
        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
        aria-hidden
      />

      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-2.5">
        <Zap className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />

        <p className="flex-1 text-sm text-amber-900 dark:text-amber-200">
          <span className="font-semibold">{label} in progress</span>
          {total > 0 && (
            <>
              {" — "}
              <span className="tabular-nums">
                {completed.toLocaleString()} / {total.toLocaleString()}
              </span>{" "}
              ({pct}%)
            </>
          )}
          {". "}
          <span className="text-amber-700 dark:text-amber-300">
            Navigating away from this tab will cancel it.
          </span>
        </p>

        <button
          type="button"
          aria-label="Dismiss banner"
          onClick={() => setDismissed(true)}
          className="rounded-md p-1 text-amber-600 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/40 dark:hover:text-amber-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {latestPersonaName && (
        <div className="mx-auto flex max-w-6xl px-6 pb-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mr-1.5 h-3 w-3 shrink-0 translate-y-px" aria-hidden />
          Latest: {latestPersonaName}
        </div>
      )}
    </div>
  );
}
