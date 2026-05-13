"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// User-facing visual preferences.
//
// Persisted in localStorage so a power user who enables cursor effects once
// stays opted-in across sessions. SEs running demos don't get this on by
// default — that's the hard rule from the design pass.
//
// SECURITY: holds only display preferences. No API keys, no PII.

interface PreferencesStore {
  /** When true, the persona-avatar cursor trail renders during generation. */
  cursorEffects: boolean;
  setCursorEffects: (v: boolean) => void;
  /** When true, the push-complete celebration plays a short audio cue.
   *  Defaults to ON. Persisted to localStorage under `plumage_sound_enabled`
   *  (separate key from the other preferences so it can be read by the
   *  audio code at fire time without subscribing to the store). */
  soundEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;
  /** When true, button clicks across the app play a soft chime. Defaults
   *  to ON — the click is short and quiet enough to feel like tactile
   *  feedback rather than noise. Persisted to localStorage under
   *  `plumage_click_sound_enabled`. */
  clickSoundEnabled: boolean;
  setClickSoundEnabled: (v: boolean) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      cursorEffects: false,
      setCursorEffects: (v) => set({ cursorEffects: v }),
      soundEnabled: true,
      setSoundEnabled: (v) => {
        set({ soundEnabled: v });
        try {
          localStorage.setItem("plumage_sound_enabled", String(v));
        } catch {
          /* private browsing — settings just won't persist */
        }
      },
      clickSoundEnabled: true,
      setClickSoundEnabled: (v) => {
        set({ clickSoundEnabled: v });
        try {
          localStorage.setItem("plumage_click_sound_enabled", String(v));
        } catch {
          /* ignore */
        }
      },
    }),
    {
      name: "plumage:preferences:v1",
      storage: createJSONStorage(() => localStorage),
      // On rehydrate, sync the dedicated sound-pref keys so the audio code
      // reads the right initial values even on first session. We mirror to
      // separate localStorage keys because the audio module is React-free
      // and reads localStorage directly.
      onRehydrateStorage: () => (state) => {
        if (state && typeof window !== "undefined") {
          try {
            if (localStorage.getItem("plumage_sound_enabled") === null) {
              localStorage.setItem("plumage_sound_enabled", String(state.soundEnabled));
            }
            if (localStorage.getItem("plumage_click_sound_enabled") === null) {
              localStorage.setItem(
                "plumage_click_sound_enabled",
                String(state.clickSoundEnabled),
              );
            }
          } catch {
            /* ignore */
          }
        }
      },
    },
  ),
);
