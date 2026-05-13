"use client";

import { useEffect } from "react";
import { playButtonClick } from "@/lib/effects/sound-effects";

// Global click listener — fires the button click chime once per click on
// any interactive-looking element. Covers:
//   • <button>           (shadcn Button + any plain native button)
//   • <a href>           (links — they're clickable too)
//   • [role="button"]    (Radix triggers, custom div-buttons)
//   • <input type="button|submit|reset|checkbox|radio">
//   • [data-clickable]   (opt-in for anything custom)
//
// Mounted once globally from app/layout.tsx. The actual sound function
// (playButtonClick) checks the opt-in preference internally, so this
// listener is cheap when sounds are disabled — a closest() lookup + a
// short-circuit.
//
// Why click and not pointerdown: we want the sound to fire when the user
// actually completes a click, not on press-then-cancel. Matches the
// "click feedback" mental model.
//
// We listen with `capture: false` (default) so that consumer handlers can
// still call `stopPropagation()` if they really don't want the chime — a
// legitimate escape hatch, e.g. for high-frequency slider thumb clicks.

const SELECTOR =
  'button, [role="button"], a[href], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], [data-clickable]';

export function ButtonClickListener() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Walk up the DOM to find the nearest interactive ancestor. Lets a
      // click on the icon *inside* a button still register.
      const interactive = target.closest(SELECTOR);
      if (!interactive) return;
      // Skip disabled controls — they don't visually accept input so a
      // chime would lie.
      if (interactive.matches(":disabled, [aria-disabled='true']")) return;
      void playButtonClick();
    }
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  return null;
}
