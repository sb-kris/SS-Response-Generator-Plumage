// View Transitions API helper for theme switches.
//
// The View Transitions API snapshots the DOM before and after a mutation,
// then animates between them via the ::view-transition-old/new pseudo-
// elements (styled in globals.css). For our case the "mutation" is either
// toggling next-themes' light/dark class or adding/removing one of the
// `theme-*` classes on <html>.
//
// Falls back to an instant mutation in three cases:
//   • SSR / no `document` — JS-only API.
//   • Browser doesn't support View Transitions (Firefox today, older
//     Safari/Chromium). The check is on the function itself, not a
//     user-agent string.
//   • The user prefers reduced motion — a hard rule from the design pass.

// Minimal typing — the DOM lib types still treat this as experimental in
// some TypeScript versions, so we type our slice explicitly rather than
// pulling in @types/dom-view-transitions.
type StartViewTransitionFn = (cb: () => void) => { finished: Promise<void> };

export function startThemeTransition(mutate: () => void): void {
  if (typeof document === "undefined") {
    mutate();
    return;
  }

  const start = (
    document as unknown as { startViewTransition?: StartViewTransitionFn }
  ).startViewTransition;

  if (typeof start !== "function") {
    mutate();
    return;
  }

  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    mutate();
    return;
  }

  // .call binds `document` as `this` — startViewTransition is a method on
  // document and throws when called detached.
  start.call(document, mutate);
}
