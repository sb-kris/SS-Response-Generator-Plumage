"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Persona } from "@/lib/generation/persona-types";

// Phase 4 store — holds the synthesized persona array (sessionStorage-backed)
// and the live progress state for the Synthesize step.
//
// Phase 7a additions: incremental persistence + interrupt detection.
//   - `appendPersonas(batch)` is called per SSE `personas_enriched` event
//     so the personas array is alive in sessionStorage as the run
//     progresses. Idempotent on persona.id (later batches overwrite
//     earlier seed-only versions of the same persona).
//   - `partialize` persists the personas unconditionally and keeps the
//     run status verbatim. On rehydration, a leftover "running" status
//     becomes "interrupted" so the UI can offer recovery.
//
// SECURITY: this store NEVER holds API keys.

export type SynthesisStatus =
  | "idle"
  | "running"
  | "complete"
  | "error"
  | "aborted"
  /** Set on rehydration when sessionStorage held a `running` status — the
   *  tab closed mid-run. Triggers the recovery card. */
  | "interrupted";

export interface SynthesisProgress {
  completed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  /** Wall-clock ms when the run started — used to estimate ETA. */
  startedAt: number | null;
  /** Estimated total wall-clock seconds (from cost estimator at start). */
  estimatedSeconds: number | null;
  /** Non-fatal warnings encountered during the run. */
  warnings: string[];
}

interface PersonasStore {
  personas: Persona[];
  status: SynthesisStatus;
  error: string | null;
  progress: SynthesisProgress;
  /** Hash of the config that produced `personas` — used to detect drift. */
  sourceConfigHash: string | null;

  // Mutations
  startRun: (totalBatches: number, total: number, estimatedSeconds: number | null) => void;
  reportProgress: (p: { completed: number; total: number; currentBatch: number }) => void;
  reportWarning: (message: string) => void;
  /** Append a single batch of enriched personas. Replaces by id so a
   *  later enrichment version supersedes any earlier seed-only entry. */
  appendPersonas: (batch: Persona[]) => void;
  finishRun: (personas: Persona[], sourceConfigHash: string) => void;
  failRun: (message: string) => void;
  abortRun: () => void;
  reset: () => void;
}

const idleProgress: SynthesisProgress = {
  completed: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  startedAt: null,
  estimatedSeconds: null,
  warnings: [],
};

export const usePersonasStore = create<PersonasStore>()(
  persist(
    (set) => ({
      personas: [],
      status: "idle",
      error: null,
      progress: idleProgress,
      sourceConfigHash: null,

      startRun: (totalBatches, total, estimatedSeconds) =>
        set({
          // Fresh run — clear personas so partial leftovers don't blend in.
          personas: [],
          status: "running",
          error: null,
          progress: {
            ...idleProgress,
            total,
            totalBatches,
            startedAt: Date.now(),
            estimatedSeconds,
          },
        }),

      reportProgress: (p) =>
        set((s) => ({
          progress: {
            ...s.progress,
            completed: p.completed,
            total: p.total,
            currentBatch: p.currentBatch,
          },
        })),

      reportWarning: (message) =>
        set((s) => ({
          progress: {
            ...s.progress,
            warnings: [...s.progress.warnings, message],
          },
        })),

      appendPersonas: (batch) =>
        set((s) => {
          if (batch.length === 0) return s;
          const byId = new Map(s.personas.map((p) => [p.id, p] as const));
          for (const p of batch) {
            byId.set(p.id, p); // overwrite seed-only with enriched
          }
          return { personas: Array.from(byId.values()) };
        }),

      finishRun: (personas, sourceConfigHash) =>
        set((s) => ({
          status: "complete",
          // Reconciliation: replace with authoritative server-side final.
          personas,
          sourceConfigHash,
          progress: {
            ...s.progress,
            completed: personas.length,
          },
        })),

      failRun: (message) =>
        set({ status: "error", error: message }),

      abortRun: () =>
        set({ status: "aborted", error: "Synthesis was cancelled." }),

      reset: () =>
        set({
          personas: [],
          status: "idle",
          error: null,
          progress: idleProgress,
          sourceConfigHash: null,
        }),
    }),
    {
      name: "plumage:personas:v2",
      // sessionStorage so the personas array survives accidental refreshes
      // but doesn't leak into a future session.
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") return undefinedStorage;
        return window.sessionStorage;
      }),
      // 7a: persist personas always; keep status verbatim.
      partialize: (state) => ({
        personas: state.personas,
        status: state.status,
        error: state.error,
        sourceConfigHash: state.sourceConfigHash,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Tab closed mid-run → mark as interrupted for recovery UI.
        if (state.status === "running") {
          state.status = "interrupted";
          state.error =
            "Synthesis was interrupted before it finished — the tab was closed or the network dropped.";
        }
        state.progress = idleProgress;
      },
      version: 2,
    },
  ),
);

/**
 * Cheap hash of the inputs that drive synthesis. Used to detect when the
 * cached personas no longer match the current configuration so the UI can
 * prompt for a re-synthesis.
 */
export function hashSynthesisInputs(input: {
  responseCount: number;
  surveyId: number | null;
  draftJson: string;
}): string {
  // Tiny FNV-1a hash — good enough for our drift detection and avoids a
  // dep on a hashing library.
  let h = 0x811c9dc5;
  const s = `${input.responseCount}|${input.surveyId ?? "x"}|${input.draftJson}`;
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
