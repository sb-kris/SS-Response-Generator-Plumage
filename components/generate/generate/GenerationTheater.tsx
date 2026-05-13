"use client";

import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import type { GeneratedResponse } from "@/lib/generation/response-types";
import type { Persona } from "@/lib/generation/persona-types";

// Live "terminal" feed shown during response generation.
//
// Why this exists: a progress bar tells you it's working; a feed tells you
// what specifically is happening. SEs running a live demo can watch real
// names, languages, and ratings stream by — turns the wait into a story.
//
// Design constraints:
//   • Terminal aesthetic — three-dot chrome, plumage://generation label,
//     monospace text, zinc-950 background regardless of app theme.
//   • Capped at 50 visible events so memory and DOM stay bounded on long
//     runs (5,000 personas would otherwise pile up indefinitely).
//   • Auto-scrolls to the bottom on new events — newest at bottom matches
//     terminal/log conventions.
//   • Respects prefers-reduced-motion: skips the slide-in animation but
//     still renders events.
//   • Timestamps captured on first-sighting via a ref-backed cache, since
//     the store doesn't persist per-event times.

const MAX_VISIBLE = 50;

interface FeedEvent {
  id: string;
  timestamp: string;
  kind: "success" | "warning" | "info";
  text: string;
}

export function GenerationTheater() {
  const responses = useResponsesStore((s) => s.responses);
  const warnings = useResponsesStore((s) => s.progress.warnings);
  const personas = usePersonasStore((s) => s.personas);
  const reduced = useReducedMotion();

  const events = useFeedEvents(responses, warnings, personas);

  // Auto-scroll to bottom when new events arrive. Smooth scroll feels more
  // alive than instant snap; one-shot effect keyed on event count.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [events.length, reduced]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-sm">
      {/* Window chrome — three colored dots and a fake URL.
          Intentionally light: no buttons, no controls. It's set dressing
          that signals "this is a real-time feed" without inviting
          interaction it doesn't actually support. */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" aria-hidden />
        </div>
        <span className="ml-1 font-mono text-[10px] text-zinc-500">
          plumage://generation
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600 tabular-nums">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </div>

      <div
        ref={containerRef}
        className="h-[280px] overflow-y-auto overflow-x-hidden p-3 font-mono text-[11px] leading-relaxed scrollbar-thin"
      >
        {events.length === 0 ? (
          <p className="text-zinc-600">{"› Waiting for responses…"}</p>
        ) : (
          <AnimatePresence initial={false}>
            {events.map((e) => (
              <motion.div
                key={e.id}
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="flex gap-2"
              >
                <span className="shrink-0 text-zinc-600 tabular-nums">[{e.timestamp}]</span>
                <span
                  className={
                    e.kind === "success"
                      ? "shrink-0 text-emerald-400"
                      : e.kind === "warning"
                        ? "shrink-0 text-amber-400"
                        : "shrink-0 text-zinc-500"
                  }
                  aria-hidden
                >
                  {e.kind === "success" ? "✓" : e.kind === "warning" ? "⚠" : "›"}
                </span>
                <span className="text-zinc-300 break-words">{e.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event derivation
// ---------------------------------------------------------------------------

/**
 * Derive a chronological feed from the responses + warnings stores.
 *
 * The stores don't track per-event timestamps, so we capture the time the
 * first time we see each event (keyed by stable id) and reuse that on
 * subsequent renders. The cache lives in a ref so it survives renders
 * without participating in the dependency graph.
 *
 * Order: responses in the order they were added, then warnings in the
 * order they were added. Without true timestamps a tighter interleaving
 * isn't reliable; this still reads as a coherent log.
 */
function useFeedEvents(
  responses: GeneratedResponse[],
  warnings: Array<{ personaName: string; message: string }>,
  personas: Persona[],
): FeedEvent[] {
  const timeCache = useRef<Map<string, string>>(new Map());

  return useMemo(() => {
    const personaById = new Map(personas.map((p) => [p.id, p]));
    const out: FeedEvent[] = [];

    function stamp(id: string): string {
      let t = timeCache.current.get(id);
      if (!t) {
        t = formatTime(new Date());
        timeCache.current.set(id, t);
      }
      return t;
    }

    for (const r of responses) {
      const persona = personaById.get(r.personaId);
      const lang = (persona?.language ?? "").toUpperCase();
      const detailBits = [lang || null, persona?.countryName ?? null].filter(Boolean);
      const detail = detailBits.length ? ` (${detailBits.join(", ")})` : "";
      const score = firstRatingHint(r);
      const text = `Generated response for ${r.personaName}${detail}${score}`;
      const id = `r-${r.id}`;
      out.push({ id, timestamp: stamp(id), kind: "success", text });
    }

    for (let i = 0; i < warnings.length; i++) {
      const w = warnings[i]!;
      const id = `w-${i}-${w.personaName}`;
      out.push({
        id,
        timestamp: stamp(id),
        kind: "warning",
        text: `${w.personaName}: ${w.message}`,
      });
    }

    // Cap at the last MAX_VISIBLE — older entries scroll off conceptually.
    return out.slice(-MAX_VISIBLE);
  }, [responses, warnings, personas]);
}

// Try to surface a meaningful numeric score (NPS, CSAT, etc.) from a response
// to give each line texture. Returns "" if nothing numeric is at the top
// level — many answer types are objects or strings.
function firstRatingHint(r: GeneratedResponse): string {
  for (const value of Object.values(r.answers)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return ` — ${value}`;
    }
    if (
      value &&
      typeof value === "object" &&
      "rating" in value &&
      typeof (value as { rating: unknown }).rating === "number"
    ) {
      return ` — ${(value as { rating: number }).rating}`;
    }
  }
  return "";
}

function formatTime(d: Date): string {
  // HH:MM:SS, fixed-width — keeps lines aligned in the monospace column.
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
