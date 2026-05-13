"use client";

import { useEffect } from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  animate,
  useReducedMotion,
} from "framer-motion";

interface Props {
  value: number;
  /** Receives the in-progress float value (not pre-rounded). Round inside
   *  the formatter if you want integer display: `(n) => Math.round(n).toLocaleString()`.
   *  Default does exactly that. For decimal stats pass e.g. `(n) => n.toFixed(1)`. */
  format?: (n: number) => string;
  /** Tween duration in seconds. Override to ~0.4 for fast counters that
   *  change frequently (e.g. live progress) so they don't feel fussy. */
  duration?: number;
  className?: string;
}

// Animated number — tweens from the previous value to the new one with an
// expo-out ease (fast attack, gentle settle). Respects prefers-reduced-motion
// by snapping straight to the target value with no transition.
//
// Why useMotionValue + useTransform: the count animates as a continuous
// float; useTransform formats once per frame. This is cheaper than
// re-rendering the component on every frame via setState.
//
// Rounding is deliberately *not* applied inside the transform — the caller's
// format function decides. Integer displays use the default formatter
// (which rounds); decimal displays pass `(n) => n.toFixed(N)` directly.
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 0.6,
  className,
}: Props) {
  const reduced = useReducedMotion();
  const count = useMotionValue(value);
  const rendered = useTransform(count, format);

  useEffect(() => {
    if (reduced) {
      // Snap immediately — no animation. Still uses motionValue so the
      // rendered transform fires once with the new value.
      count.set(value);
      return;
    }
    const controls = animate(count, value, {
      duration,
      ease: [0.16, 1, 0.3, 1], // expo-out
    });
    return controls.stop;
  }, [value, count, duration, reduced]);

  return <motion.span className={className}>{rendered}</motion.span>;
}
