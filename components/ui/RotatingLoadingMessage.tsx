"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { pickLoadingMessage } from "@/lib/copy/loading-messages";
import { cn } from "@/lib/utils";

interface Props {
  /** Message pool to draw from. Falls back to "Working..." if empty. */
  pool: string[];
  /** How often to rotate, in milliseconds. Default: 2500ms (2.5s). */
  intervalMs?: number;
  className?: string;
}

// Rotating loading message with a soft fade between picks.
//
// Picks a new message every `intervalMs` and animates the swap via
// AnimatePresence (4px slide-up enter, 4px slide-up exit). With reduced
// motion preferred, falls back to a hard text swap — no transition.
//
// Pools live in `lib/copy/loading-messages.ts`. The first message is picked
// synchronously on mount so there's no flash of empty space.
export function RotatingLoadingMessage({
  pool,
  intervalMs = 2500,
  className,
}: Props) {
  const reduced = useReducedMotion();
  const [message, setMessage] = useState(() => pickLoadingMessage(pool));

  useEffect(() => {
    const id = setInterval(() => {
      setMessage((current) => {
        // Avoid showing the same message twice in a row when possible — it
        // looks like the rotator froze. One re-pick is enough; if the pool
        // is small enough that we collide twice in a row, that's fine.
        let next = pickLoadingMessage(pool);
        if (next === current && pool.length > 1) next = pickLoadingMessage(pool);
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [pool, intervalMs]);

  if (reduced) {
    return <span className={className}>{message}</span>;
  }

  return (
    <span className={cn("inline-block", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={message}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="inline-block"
        >
          {message}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
