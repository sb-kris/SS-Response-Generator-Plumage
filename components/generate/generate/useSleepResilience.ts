"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Phase 7e — Sleep resilience.
 *
 * While `active` is true:
 *   1. Acquires navigator.wakeLock.request("screen") to prevent the display
 *      from sleeping. The browser releases the lock automatically when the tab
 *      is hidden; we re-acquire when the tab becomes visible again.
 *   2. Shows a persistent sonner toast when the tab is hidden, reminding the
 *      user that throttling may slow generation. Dismissed automatically when
 *      the tab comes back.
 *
 * LIMITATION (documented in GeneratingCard): the Wake Lock prevents screen
 * sleep only. Closing the laptop lid / OS idle-sleep kills the Node.js process
 * on localhost — no software fix from inside the app. If the connection drops,
 * Phase 7a's recovery card lets the user resume from where it stopped.
 */
export function useSleepResilience(active: boolean) {
  // ----- Wake Lock -----
  const lockRef = useRef<WakeLockSentinel | null>(null);
  // Stable ref so the visibility handler closure always reads the current value.
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (!active) {
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      return;
    }

    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        lockRef.current = sentinel;
        // Browser will release automatically on tab hide — no need to listen;
        // the visibilitychange handler below re-acquires on show.
      } catch {
        // Permission denied or not supported — silent degradation.
      }
    };

    void acquire();

    const handleVis = () => {
      if (document.visibilityState === "visible" && activeRef.current && !lockRef.current) {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", handleVis);

    return () => {
      document.removeEventListener("visibilitychange", handleVis);
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);

  // ----- Visibility warning toast -----
  const toastIdRef = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      if (toastIdRef.current !== undefined) {
        toast.dismiss(toastIdRef.current);
        toastIdRef.current = undefined;
      }
      return;
    }

    const handleVis = () => {
      if (document.visibilityState === "hidden") {
        toastIdRef.current = toast.warning("Tab is hidden — generation may slow", {
          description:
            "Browsers throttle background tabs. Keep Plumage in view for best speed.",
          duration: Infinity,
        });
      } else {
        if (toastIdRef.current !== undefined) {
          toast.dismiss(toastIdRef.current);
          toastIdRef.current = undefined;
        }
      }
    };

    document.addEventListener("visibilitychange", handleVis);
    return () => {
      document.removeEventListener("visibilitychange", handleVis);
      if (toastIdRef.current !== undefined) {
        toast.dismiss(toastIdRef.current);
        toastIdRef.current = undefined;
      }
    };
  }, [active]);
}
