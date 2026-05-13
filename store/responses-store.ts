"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { GeneratedResponse, ResponseStatus } from "@/lib/generation/response-types";

// Phase 5a store — holds the generated responses array (sessionStorage-backed)
// and the live progress state for the Generate step.
//
// Phase 7a additions: incremental persistence + interrupt detection.
//   - `appendResponse(r)` is called per SSE `response_completed` event so
//     the responses array is alive in sessionStorage as the run progresses.
//   - `partialize` now persists the responses array unconditionally and
//     keeps the run status verbatim. On rehydration, a stored "running"
//     status (which can only happen if the previous tab was closed
//     mid-run) is converted to `"interrupted"` so the UI can offer a
//     recovery / resume CTA instead of silently dropping the work.
//   - `resumeRun(remainingTotal)` starts a new generation segment without
//     wiping the responses already in store — used when the user clicks
//     "Resume" on the recovery card.
//
// SECURITY: this store NEVER holds API keys.

export type GenerationStatus =
  | "idle"
  | "running"
  | "complete"
  | "error"
  | "aborted"
  /** Set on rehydration when sessionStorage held a `running` status — the
   *  only way that happens is if the previous tab closed mid-run.
   *  Triggers the recovery card. */
  | "interrupted";
export type PushStatus = "idle" | "running" | "complete";

export interface DebugEntry {
  time: number;
  kind:
    | "worker_start"
    | "worker_done"
    | "worker_fail"
    | "rate_limit"
    | "retry"
    | "info"
    | "batch_start"
    | "batch_ok"
    | "batch_fail";
  label: string;
  /** Extra context: error message, retry reason, etc. */
  detail?: string;
  /** Wall-clock ms from dispatch to settlement (worker_done only). */
  latencyMs?: number;
  /** Rate-limit sleep in ms (rate_limit only). */
  backoffMs?: number;
}

export interface GenerationProgress {
  completed: number;
  total: number;
  latestPersonaName: string;
  startedAt: number | null;
  estimatedSeconds: number | null;
  warnings: Array<{ personaName: string; message: string }>;
}

export interface PushProgress {
  pushed: number;
  failed: number;
  total: number;
}

interface ResponsesStore {
  responses: GeneratedResponse[];
  status: GenerationStatus;
  error: string | null;
  progress: GenerationProgress;
  sourceConfigHash: string | null;

  // Phase 5c — push flow
  pushStatus: PushStatus;
  pushProgress: PushProgress;
  /** When true, the Generate step jumps straight to the push card after
   *  generation finishes instead of showing the preview table. */
  skipPreview: boolean;

  // Generation actions
  startRun: (total: number, estimatedSeconds: number | null) => void;
  /** Continue an interrupted run. Keeps existing responses and initialises
   *  progress from the already-completed count so the progress bar shows
   *  "22 / 50" immediately rather than jumping from "0/28" on first event. */
  resumeRun: (initialCompleted: number, overallTotal: number, estimatedSeconds: number | null) => void;
  reportProgress: (p: { completed: number; total: number; latestPersonaName: string }) => void;
  reportPersonaWarning: (personaName: string, message: string) => void;
  /** Append a single response as it lands. Idempotent on `id`. */
  appendResponse: (response: GeneratedResponse) => void;
  finishRun: (responses: GeneratedResponse[], sourceConfigHash: string) => void;
  failRun: (message: string) => void;
  abortRun: () => void;
  reset: () => void;

  // Phase 5c — push actions
  setSkipPreview: (v: boolean) => void;
  startPush: (total: number) => void;
  recordPushResult: (
    responseId: string,
    success: boolean,
    pushedResponseId?: string,
    errorMessage?: string,
  ) => void;
  finishPush: () => void;
  resetPush: () => void;

  // Debug log (ephemeral — not persisted)
  debugLog: DebugEntry[];
  appendDebugLog: (entry: DebugEntry) => void;
  clearDebugLog: () => void;
}

const idleProgress: GenerationProgress = {
  completed: 0,
  total: 0,
  latestPersonaName: "",
  startedAt: null,
  estimatedSeconds: null,
  warnings: [],
};

const idlePushProgress: PushProgress = { pushed: 0, failed: 0, total: 0 };

export const useResponsesStore = create<ResponsesStore>()(
  persist(
    (set) => ({
      responses: [],
      status: "idle",
      error: null,
      progress: idleProgress,
      sourceConfigHash: null,
      pushStatus: "idle",
      pushProgress: idlePushProgress,
      skipPreview: false,
      debugLog: [],

      startRun: (total, estimatedSeconds) =>
        set({
          // Fresh run — clear responses and debug log.
          responses: [],
          status: "running",
          error: null,
          pushStatus: "idle",
          pushProgress: idlePushProgress,
          debugLog: [],
          progress: {
            ...idleProgress,
            total,
            startedAt: Date.now(),
            estimatedSeconds,
          },
        }),

      resumeRun: (initialCompleted, overallTotal, estimatedSeconds) =>
        set((s) => ({
          // Keep existing responses — this is a continuation.
          status: "running",
          error: null,
          progress: {
            ...idleProgress,
            // Start from the already-completed offset so the bar shows
            // "22 / 50" immediately instead of jumping from "0/28".
            completed: initialCompleted,
            total: overallTotal,
            startedAt: Date.now(),
            estimatedSeconds,
            warnings: s.progress.warnings, // preserve prior warnings
          },
        })),

      reportProgress: (p) =>
        set((s) => ({
          progress: {
            ...s.progress,
            completed: p.completed,
            total: p.total,
            latestPersonaName: p.latestPersonaName,
          },
        })),

      reportPersonaWarning: (personaName, message) =>
        set((s) => ({
          progress: {
            ...s.progress,
            warnings: [...s.progress.warnings, { personaName, message }],
          },
        })),

      appendResponse: (response) =>
        set((s) => {
          // Dedup by id — `complete` reconciliation may also come through.
          if (s.responses.some((r) => r.id === response.id)) return s;
          return { responses: [...s.responses, response] };
        }),

      finishRun: (responses, sourceConfigHash) =>
        set((s) => ({
          status: "complete",
          // Reconciliation: replace with the authoritative server-side
          // final array. Catches any incremental events lost to network blips.
          responses,
          sourceConfigHash,
          progress: {
            ...s.progress,
            completed: responses.length,
          },
        })),

      failRun: (message) => set({ status: "error", error: message }),

      abortRun: () => set({ status: "aborted", error: "Generation was cancelled." }),

      reset: () =>
        set({
          responses: [],
          status: "idle",
          error: null,
          progress: idleProgress,
          sourceConfigHash: null,
          pushStatus: "idle",
          pushProgress: idlePushProgress,
        }),

      // Phase 5c
      setSkipPreview: (v) => set({ skipPreview: v }),

      startPush: (total) =>
        set({
          pushStatus: "running",
          pushProgress: { pushed: 0, failed: 0, total },
        }),

      recordPushResult: (responseId, success, pushedResponseId, errorMessage) =>
        set((s) => {
          const newStatus: ResponseStatus = success ? "pushed" : "failed";
          const responses = s.responses.map((r) =>
            r.id === responseId
              ? {
                  ...r,
                  status: newStatus,
                  ...(pushedResponseId ? { pushedResponseId } : {}),
                  ...(errorMessage ? { errorMessage } : {}),
                }
              : r,
          );
          const pushProgress = {
            ...s.pushProgress,
            pushed: s.pushProgress.pushed + (success ? 1 : 0),
            failed: s.pushProgress.failed + (success ? 0 : 1),
          };
          return { responses, pushProgress };
        }),

      finishPush: () => set({ pushStatus: "complete" }),

      resetPush: () =>
        set((s) => ({
          pushStatus: "idle",
          pushProgress: idlePushProgress,
          responses: s.responses.map((r) => ({
            ...r,
            status: "generated" as ResponseStatus,
            pushedResponseId: undefined,
            errorMessage: undefined,
          })),
        })),

      appendDebugLog: (entry) =>
        set((s) => ({ debugLog: [...s.debugLog.slice(-199), entry] })),
      clearDebugLog: () => set({ debugLog: [] }),
    }),
    {
      name: "plumage:responses:v2",
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") return undefinedStorage;
        return window.sessionStorage;
      }),
      // 7a: persist the responses array always (so partial work survives a
      // tab close), and keep the status verbatim — onRehydrateStorage below
      // converts a leftover "running" into "interrupted".
      partialize: (state) => ({
        responses: state.responses,
        status: state.status,
        error: state.error,
        sourceConfigHash: state.sourceConfigHash,
        skipPreview: state.skipPreview,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // The only way "running" makes it to disk is if the tab closed
        // before finishRun/failRun fired. Surface that explicitly.
        if (state.status === "running") {
          state.status = "interrupted";
          state.error =
            "Generation was interrupted before it finished — the tab was closed or the network dropped.";
        }
        // Don't carry transient runtime fields across reload.
        state.progress = idleProgress;
        state.pushStatus = "idle";
        state.pushProgress = idlePushProgress;
        state.debugLog = [];
      },
      version: 2,
    },
  ),
);

export function hashGenerationInputs(input: {
  personasHash: string;
  questionCount: number;
  responseModelId: string;
  surveyId: number | null;
}): string {
  let h = 0x811c9dc5;
  const s = `${input.personasHash}|${input.questionCount}|${input.responseModelId}|${input.surveyId ?? "x"}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

const undefinedStorage: Storage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};
