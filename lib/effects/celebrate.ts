// First-push celebration effect.
//
// Fires confetti + audio once per session when responses successfully land
// in SurveySparrow. Subsequent pushes in the same session are silent —
// the celebration is for the milestone, not every push. A manual replay
// path exists via replayCelebration() for the small speaker button next
// to the success alert.
//
// Imports are lazy (dynamic) so canvas-confetti doesn't end up in the SSR
// bundle or fire on the server. Also gracefully no-ops if the user has
// `prefers-reduced-motion` set — celebrations are nice-to-have, not
// essential, and a hard rule of the design pass is to respect motion prefs.

import { playCelebration } from "./sound-effects";

let firedThisSession = false;

// Mixed palette: Plumage indigo + SurveySparrow teal + warm accents.
// Avoids generic rainbow confetti — looks intentional.
const COLORS = ["#6366f1", "#3FA9B0", "#a78bfa", "#fbbf24"];

/** localStorage key for the sound mute preference. */
export const SOUND_PREF_KEY = "plumage_sound_enabled";

/**
 * Internal: run the confetti burst with no once-per-session guard. Used
 * by both the auto-fire path (celebrateFirstPush) and the manual replay
 * path (replayCelebration).
 */
async function fireVisuals(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const { default: confetti } = await import("canvas-confetti");
  confetti({
    particleCount: 80,
    spread: 60,
    origin: { y: 0.7, x: 0.3 },
    colors: COLORS,
    scalar: 0.9,
  });
  setTimeout(() => {
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.7, x: 0.7 },
      colors: COLORS,
      scalar: 0.9,
    });
  }, 150);
}

export async function celebrateFirstPush(): Promise<void> {
  if (firedThisSession) return;
  if (typeof window === "undefined") return;
  // Even with reduced motion, mark fired so we don't keep trying.
  firedThisSession = true;
  await fireVisuals();
  // Sound respects its own enabled preference (read inside playCelebration).
  void playCelebration();
}

/**
 * Manual replay — fires from the small speaker button next to the
 * "All responses pushed" success alert. Always fires, regardless of the
 * once-per-session guard; reduced-motion users still get just the sound.
 */
export async function replayCelebration(): Promise<void> {
  await fireVisuals();
  void playCelebration();
}

/** Re-arm the once-per-session guard. Called from the sign-out flow so a
 *  fresh sign-in gets its own celebration. */
export function resetCelebration(): void {
  firedThisSession = false;
}
