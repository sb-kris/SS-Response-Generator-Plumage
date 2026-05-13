"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import type { GeneratedResponse } from "@/lib/generation/response-types";
import type { Persona } from "@/lib/generation/persona-types";

interface Props {
  /** The response the playhead is currently aligned with. Null until the
   *  playhead crosses the first response. */
  response: GeneratedResponse | null;
  /** Persona resolved from `response.personaId`. Null if the persona isn't
   *  in the current store (shouldn't happen, but defensive). */
  persona: Persona | null;
  /** Playhead position in [0, 1] across the track. The card translates
   *  horizontally to align with this — with a centring offset. */
  playheadPct: number;
}

// Floating card that follows the timeline playhead.
//
// Positioned absolutely above the track, translated by playheadPct% then
// centered on its own width via -50% translateX. AnimatePresence keys on
// response id so swapping personas during playback produces a clean fade.
//
// Stays narrow (max-w-[260px]) so it doesn't fight the track underneath
// or push the sparkline off-screen on narrow viewports.
export function PlayheadCard({ response, persona, playheadPct }: Props) {
  const reduced = useReducedMotion();

  return (
    <div
      className="pointer-events-none absolute -top-1 -translate-y-full"
      style={{ left: `${playheadPct * 100}%` }}
      aria-hidden={response ? undefined : true}
    >
      <div className="-translate-x-1/2">
        <AnimatePresence mode="wait">
          {response && (
            <motion.div
              key={response.id}
              initial={reduced ? false : { opacity: 0, y: 6, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="w-max max-w-[260px] rounded-lg border bg-popover/95 px-3 py-2 shadow-md backdrop-blur"
            >
              <div className="flex items-center gap-2.5">
                {/* Avatar — same DiceBear URL the table uses; cached. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(response.personaId)}`}
                  alt=""
                  width={32}
                  height={32}
                  className="h-8 w-8 shrink-0 rounded-full bg-muted"
                  loading="eager"
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium leading-tight">
                    {response.personaName}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-mono tabular-nums">
                      {formatTime(response.generatedAt)}
                    </span>
                    {persona && (
                      <>
                        <span className="opacity-50">·</span>
                        <span>
                          {countryFlag(persona.country)}{" "}
                          <span className="uppercase">{persona.language}</span>
                        </span>
                        <span className="opacity-50">·</span>
                        <SentimentBadge sentiment={persona.sentimentArchetype} />
                      </>
                    )}
                    {(() => {
                      const hint = firstScoreHint(response);
                      return hint ? (
                        <>
                          <span className="opacity-50">·</span>
                          <span className="font-mono tabular-nums">{hint}</span>
                        </>
                      ) : null;
                    })()}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * ISO 3166-1 alpha-2 → flag emoji via regional indicator symbols.
 * "US" → 🇺🇸. Returns empty string for invalid input so the join elides.
 */
function countryFlag(code: string | undefined): string {
  if (!code || code.length !== 2) return "";
  const A = 0x1f1e6; // REGIONAL INDICATOR SYMBOL LETTER A
  const upper = code.toUpperCase();
  const first = upper.charCodeAt(0) - 65;
  const second = upper.charCodeAt(1) - 65;
  if (first < 0 || first > 25 || second < 0 || second > 25) return "";
  return String.fromCodePoint(A + first, A + second);
}

/**
 * Try to surface a meaningful numeric score (NPS, CSAT, etc.) from a
 * response. Returns null if no top-level numeric value exists.
 * Matches the heuristic used in GenerationTheater so the two stay aligned.
 */
function firstScoreHint(r: GeneratedResponse): string | null {
  for (const value of Object.values(r.answers)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${value}`;
    }
    if (
      value &&
      typeof value === "object" &&
      "rating" in value &&
      typeof (value as { rating: unknown }).rating === "number"
    ) {
      return `${(value as { rating: number }).rating}`;
    }
  }
  return null;
}

function SentimentBadge({
  sentiment,
}: {
  sentiment: Persona["sentimentArchetype"];
}) {
  const variant =
    sentiment === "promoter"
      ? "success"
      : sentiment === "detractor"
        ? "destructive"
        : "secondary";
  const label =
    sentiment === "promoter" ? "Promoter" : sentiment === "detractor" ? "Detractor" : "Passive";
  return (
    <Badge variant={variant} className="text-[9px] leading-none">
      {label}
    </Badge>
  );
}
