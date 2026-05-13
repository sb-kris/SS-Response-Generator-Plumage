"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { usePreferencesStore } from "@/store/preferences-store";

// Cursor avatar trail — opt-in cosmetic effect.
//
// During response generation (and only then), each mouse movement drops a
// small, fading DiceBear avatar at the cursor position. The avatars cycle
// through the personas in the current batch — so a 50-persona generation
// literally shows tiny faces of those 50 people drifting behind your cursor.
//
// Critical defaults:
//   • OFF by default. SEs running demos must not get this without asking.
//   • Respects prefers-reduced-motion (hard-disables the trail).
//   • Self-disables when responses store status !== "running" — no chrome
//     in idle or preview states.
//   • Throttled to ~one breadcrumb per 120ms so high-DPI trackpads can't
//     spam the DOM.
//   • Pointer-events-none so it never intercepts clicks.
//
// DiceBear images: the persona table prefetches the same URLs during
// synthesis preview, so by the time generation starts the browser cache
// usually has them. Cold cases still degrade gracefully — the image just
// fades in over its own duration.

const THROTTLE_MS = 120;
const MAX_BREADCRUMBS = 8;
const FADE_DURATION_S = 0.8;

interface Breadcrumb {
  id: string;
  x: number;
  y: number;
  avatarSeed: string;
}

export function CursorAvatarTrail() {
  const enabled = usePreferencesStore((s) => s.cursorEffects);
  const reducedMotion = useReducedMotion();
  const status = useResponsesStore((s) => s.status);
  const personas = usePersonasStore((s) => s.personas);
  const [crumbs, setCrumbs] = useState<Breadcrumb[]>([]);

  // Active only when all three conditions hold — opt-in, motion allowed,
  // currently generating. Anything else short-circuits the effect entirely.
  const active = enabled && !reducedMotion && status === "running";

  // Track persona cycling + last-emit time in refs so the mousemove handler
  // closure stays stable (no re-binding on every state update).
  const indexRef = useRef(0);
  const lastEmitRef = useRef(0);

  useEffect(() => {
    if (!active) {
      // When toggled off or generation completes, clear any in-flight crumbs
      // so they don't linger past their welcome.
      setCrumbs([]);
      return;
    }

    function handler(e: MouseEvent) {
      const now = performance.now();
      if (now - lastEmitRef.current < THROTTLE_MS) return;
      lastEmitRef.current = now;

      const persona = personas.length > 0
        ? personas[indexRef.current % personas.length]
        : undefined;
      indexRef.current += 1;

      setCrumbs((prev) => {
        const next: Breadcrumb = {
          // ID uses both timestamp and counter — collisions impossible under
          // 120ms throttle, and React keys stay stable for AnimatePresence.
          id: `${now.toFixed(0)}-${indexRef.current}`,
          x: e.clientX,
          y: e.clientY,
          avatarSeed: persona?.id ?? "default",
        };
        const trimmed = [...prev, next];
        // Keep only the most recent MAX_BREADCRUMBS to bound DOM cost.
        return trimmed.length > MAX_BREADCRUMBS
          ? trimmed.slice(-MAX_BREADCRUMBS)
          : trimmed;
      });
    }

    window.addEventListener("mousemove", handler, { passive: true });
    return () => window.removeEventListener("mousemove", handler);
  }, [active, personas]);

  if (!active) return null;

  return (
    <div
      // z-[9999] sits above sticky headers and dialogs without blocking
      // their hit-testing — pointer-events-none is the key here.
      className="pointer-events-none fixed inset-0 z-[9999]"
      aria-hidden
    >
      <AnimatePresence>
        {crumbs.map((c) => (
          <motion.img
            key={c.id}
            // DiceBear avatar URL — identical scheme to PersonaTable / row
            // avatars, so the browser hits cache. SVG, so it scales clean.
            src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(c.avatarSeed)}`}
            alt=""
            initial={{
              opacity: 0.85,
              scale: 0.6,
              x: c.x - 8,
              y: c.y - 8,
            }}
            animate={{
              opacity: 0,
              scale: 0.4,
              // drift upward as they fade — implies the cursor "shed" them
              y: c.y - 22,
            }}
            transition={{ duration: FADE_DURATION_S, ease: "easeOut" }}
            onAnimationComplete={() => {
              // Recycle DOM nodes once the fade finishes. Without this the
              // array would never trim down to MAX_BREADCRUMBS during slow
              // mouse moves — slice handles the fast-move case, this handles
              // the stationary-cursor case.
              setCrumbs((prev) => prev.filter((p) => p.id !== c.id));
            }}
            className="absolute h-4 w-4 rounded-full"
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
