"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  defaultDraft,
  mergeSystemMetadata,
  type ProfileDraft,
  type DemoProfile,
} from "@/lib/profiles/types";
import { profileToDraft } from "@/lib/storage/profiles";

// In-progress configuration draft for the Configure step. Persisted to
// sessionStorage so an accidental refresh doesn't lose work.
//
// CRITICAL: this store must NEVER hold API keys, passwords, or any other
// secret. The schema enforces this — `ProfileDraft` only carries the dials
// and content, never credentials.

export interface LoadedProfileMeta {
  id: string;
  name: string;
  /** Snapshot of the draft when the profile was loaded; used for dirty diff. */
  snapshot: ProfileDraft;
}

interface GenerationStore {
  draft: ProfileDraft;
  loadedProfile: LoadedProfileMeta | null;

  setDraft: (mutator: (draft: ProfileDraft) => ProfileDraft | void) => void;
  setUseCase: (useCase: string) => void;

  /** Replace the entire draft (e.g. on profile load) and remember the source. */
  loadProfile: (profile: DemoProfile) => void;
  /** Forget which profile this draft came from (e.g. on Save As New). */
  clearLoadedSource: () => void;
  /** Mark the current draft as the new clean baseline (after Save). */
  markPristine: (loaded?: LoadedProfileMeta) => void;
  /** Reset to factory defaults. */
  resetDraft: () => void;
}

export const useGenerationStore = create<GenerationStore>()(
  persist(
    (set) => ({
      draft: defaultDraft(),
      loadedProfile: null,

      setDraft: (mutator) =>
        set((s) => {
          // Clone so the mutator can either return a value or mutate in place.
          const cloned = structuredClone(s.draft);
          const next = mutator(cloned);
          return { draft: next ?? cloned };
        }),

      setUseCase: (useCase) =>
        set((s) => ({ draft: { ...s.draft, useCase } })),

      loadProfile: (profile) => {
        const draft = profileToDraft(profile);
        set({
          draft,
          loadedProfile: {
            id: profile.id,
            name: profile.name,
            // Deep clone so subsequent edits don't mutate the snapshot.
            snapshot: structuredClone(draft),
          },
        });
      },

      clearLoadedSource: () => set({ loadedProfile: null }),

      markPristine: (loaded) =>
        set((s) => ({
          loadedProfile: loaded
            ? loaded
            : s.loadedProfile
              ? { ...s.loadedProfile, snapshot: structuredClone(s.draft) }
              : null,
        })),

      resetDraft: () => set({ draft: defaultDraft(), loadedProfile: null }),
    }),
    {
      name: "plumage:generation-draft:v1",
      // sessionStorage so an accidental refresh restores the in-progress draft
      // but a tab close starts clean. Avoids long-lived stale state.
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") return undefinedStorage;
        return window.sessionStorage;
      }),
      partialize: (state) => ({
        draft: state.draft,
        loadedProfile: state.loadedProfile,
      }),
      version: 4,
      migrate: (stored: unknown, storedVersion: number): unknown => {
        const s = stored as { draft?: Record<string, unknown> } | null;
        if (!s?.draft) return stored;

        // v1 → v2: systemMetadata shape changed (useDefaults/device/channels → per-field objects)
        if (storedVersion < 2) {
          s.draft.systemMetadata = mergeSystemMetadata(s.draft.systemMetadata as unknown);
        }
        // v2 → v3: timeRange.start/end renamed to from/to; businessHoursWeight + responseCount added
        if (storedVersion < 3) {
          const tr = s.draft.timeRange as Record<string, unknown> | undefined;
          if (tr) {
            if (tr.from === undefined && typeof tr.start === "number") tr.from = tr.start;
            if (tr.to === undefined && typeof tr.end === "number") tr.to = tr.end;
            if (tr.businessHoursWeight === undefined) tr.businessHoursWeight = true;
            if (tr.responseCount === undefined) tr.responseCount = 200;
          }
        }
        // v3 → v4: countryFilter field added (default: no filter)
        if (storedVersion < 4) {
          if (s.draft.countryFilter === undefined) {
            s.draft.countryFilter = [];
          }
        }

        return stored;
      },
    },
  ),
);

/**
 * True if the current draft differs from the loaded profile's snapshot.
 * Returns false when no profile is loaded (since "Save as new" handles that
 * path independently).
 */
export function isDraftDirty(
  draft: ProfileDraft,
  loaded: LoadedProfileMeta | null,
): boolean {
  if (!loaded) return false;
  return JSON.stringify(draft) !== JSON.stringify(loaded.snapshot);
}

// SSR fallback that no-ops — satisfies the full `Storage` shape so we don't
// have to weaken `createJSONStorage`'s expectations.
const undefinedStorage: Storage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};
