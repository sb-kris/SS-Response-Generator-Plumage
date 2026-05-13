"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { Pause, Play, RotateCcw, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import {
  bucketizeResponses,
  findResponseIndexAtPlayhead,
} from "@/lib/timeline/buckets";
import { SentimentSparkline } from "./SentimentSparkline";
import { PlayheadCard } from "./PlayheadCard";

// Time Machine: scrub through your generation history.
//
// Built on top of data already in the responses store — each response has
// `generatedAt`, each persona has identity + sentiment. The scrubber is a
// pure read view; it doesn't mutate the stores.
//
// Three independent visualisations driven by one playheadMs state:
//   1. Sparkline — stacked area chart of cumulative sentiment, with a
//      dashed vertical line at the playhead.
//   2. Floating PlayheadCard — the persona "at" the playhead.
//   3. (Sync to table) — when the sync switch is on, the parent uses
//      `playheadMs` to filter the response table.
//
// State design:
//   • playheadMs is owned by the parent (BasicPreviewCard) so it can wire
//     into the table filter. We only read it via props and report changes
//     via onChange.
//   • Playback animation runs via Framer Motion's imperative `animate()`
//     on a local motion value; stop ref lets drag / pause interrupt cleanly.
//   • Speed 1×/4×/16× scales the wall-clock duration of playback.

interface Props {
  /** Current playhead position in ms-since-epoch. Owned by the parent. */
  playheadMs: number;
  onPlayheadChange: (ms: number) => void;
  syncTable: boolean;
  onSyncTableChange: (next: boolean) => void;
  onCollapse: () => void;
}

type Speed = 1 | 4 | 16;

export function TimelineScrubber({
  playheadMs,
  onPlayheadChange,
  syncTable,
  onSyncTableChange,
  onCollapse,
}: Props) {
  const responses = useResponsesStore((s) => s.responses);
  const personas = usePersonasStore((s) => s.personas);
  const reduced = useReducedMotion();

  // Sort once per response-array change. The store appends in arrival order,
  // which is usually-but-not-guaranteed monotonic, so we sort defensively.
  const sorted = useMemo(
    () => [...responses].sort((a, b) => a.generatedAt - b.generatedAt),
    [responses],
  );

  const startMs = sorted[0]?.generatedAt ?? 0;
  const endMs = sorted[sorted.length - 1]?.generatedAt ?? 0;
  const spanMs = Math.max(0, endMs - startMs);

  const personaById = useMemo(
    () => new Map(personas.map((p) => [p.id, p])),
    [personas],
  );

  // Buckets — 30 slices, recomputed only when responses or personas change.
  const buckets = useMemo(
    () => bucketizeResponses(sorted, personas, startMs, endMs, 30),
    [sorted, personas, startMs, endMs],
  );

  // Edge cases: too-short generations get a static note instead of a
  // useless 0-width scrubber.
  if (sorted.length <= 1 || spanMs < 1000) {
    return (
      <div className="rounded-lg border bg-card/40 p-4 text-xs text-muted-foreground">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium uppercase tracking-wider">
            Replay generation
          </span>
          <Button variant="ghost" size="sm" onClick={onCollapse} className="h-7 gap-1">
            <ChevronUp className="h-3.5 w-3.5" />
            <span className="text-[11px]">Close</span>
          </Button>
        </div>
        {sorted.length <= 1
          ? "Only one response was generated — no timeline to replay."
          : "Generation completed in under 1 second — no timeline to replay."}
      </div>
    );
  }

  return (
    <ScrubberBody
      sorted={sorted}
      personaById={personaById}
      startMs={startMs}
      endMs={endMs}
      spanMs={spanMs}
      buckets={buckets}
      playheadMs={playheadMs}
      onPlayheadChange={onPlayheadChange}
      syncTable={syncTable}
      onSyncTableChange={onSyncTableChange}
      onCollapse={onCollapse}
      reducedMotion={!!reduced}
    />
  );
}

// ---------------------------------------------------------------------------
// Body — split out so the edge-case early return above doesn't leak hooks
// into the happy path's effect graph.
// ---------------------------------------------------------------------------

interface BodyProps {
  sorted: ReturnType<typeof Array.prototype.slice>;
  personaById: Map<string, import("@/lib/generation/persona-types").Persona>;
  startMs: number;
  endMs: number;
  spanMs: number;
  buckets: import("@/lib/timeline/buckets").SentimentBucket[];
  playheadMs: number;
  onPlayheadChange: (ms: number) => void;
  syncTable: boolean;
  onSyncTableChange: (next: boolean) => void;
  onCollapse: () => void;
  reducedMotion: boolean;
}

function ScrubberBody({
  sorted,
  personaById,
  startMs,
  endMs,
  spanMs,
  buckets,
  playheadMs,
  onPlayheadChange,
  syncTable,
  onSyncTableChange,
  onCollapse,
  reducedMotion,
}: BodyProps) {
  const [speed, setSpeed] = useState<Speed>(4);
  const [isPlaying, setIsPlaying] = useState(false);
  // Stop handle for the imperative animate() — set when playback begins,
  // cleared on pause/end/reset/drag.
  const stopRef = useRef<(() => void) | null>(null);

  const responses = sorted as import("@/lib/generation/response-types").GeneratedResponse[];

  // Clamp the playhead into range so external bumps (initial mount, reset)
  // never produce out-of-range positions.
  const clampedPlayhead = Math.min(endMs, Math.max(startMs, playheadMs));
  const playheadPct = spanMs > 0 ? (clampedPlayhead - startMs) / spanMs : 0;
  const responseIdx = findResponseIndexAtPlayhead(responses, clampedPlayhead);
  const currentResponse = responseIdx >= 0 ? responses[responseIdx]! : null;
  const currentPersona = currentResponse
    ? personaById.get(currentResponse.personaId) ?? null
    : null;

  // ── Playback ─────────────────────────────────────────────────────────────

  function stopAnimation() {
    stopRef.current?.();
    stopRef.current = null;
  }

  function play() {
    // Already at the end? Start from the beginning.
    const from = clampedPlayhead >= endMs ? startMs : clampedPlayhead;
    const remainingMs = endMs - from;
    if (remainingMs <= 0) return;

    const durationS = remainingMs / 1000 / speed;
    setIsPlaying(true);

    if (reducedMotion) {
      // Reduced motion: jump to the end instead of animating. Still toggles
      // playing state for the brief moment so the UI is consistent.
      onPlayheadChange(endMs);
      setIsPlaying(false);
      return;
    }

    const controls = animate(from, endMs, {
      duration: durationS,
      ease: "linear",
      onUpdate: (latest) => onPlayheadChange(latest),
      onComplete: () => {
        setIsPlaying(false);
        stopRef.current = null;
      },
    });
    stopRef.current = controls.stop;
  }

  function pause() {
    stopAnimation();
    setIsPlaying(false);
  }

  function reset() {
    stopAnimation();
    setIsPlaying(false);
    onPlayheadChange(startMs);
  }

  // Stop any active animation when the component unmounts or speed changes
  // mid-playback. Speed change → restart from current position at new speed.
  useEffect(() => {
    return () => stopAnimation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPlaying) {
      stopAnimation();
      // Re-issue play at the new speed from the current position.
      play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  // ── Keyboard: arrow keys advance one response when the scrubber is focused.
  // The radix Slider has its own arrow handling for value changes, so we
  // attach to a wrapper and only act when the slider thumb has focus.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const active = document.activeElement;
      if (!el?.contains(active)) return;
      e.preventDefault();
      stopAnimation();
      setIsPlaying(false);
      const step = e.key === "ArrowLeft" ? -1 : 1;
      const target = Math.min(
        responses.length - 1,
        Math.max(0, responseIdx + step),
      );
      onPlayheadChange(responses[target]!.generatedAt);
    }
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [responses, responseIdx, onPlayheadChange]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div ref={wrapperRef} className="rounded-lg border bg-card/40 p-4">
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Replay generation
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {responseIdx + 1} / {responses.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Switch
              id="sync-table"
              checked={syncTable}
              onCheckedChange={onSyncTableChange}
            />
            <Label
              htmlFor="sync-table"
              className="cursor-pointer text-[11px] text-muted-foreground"
            >
              Sync table
            </Label>
          </div>
          <Button variant="ghost" size="sm" onClick={onCollapse} className="h-7 gap-1">
            <ChevronUp className="h-3.5 w-3.5" />
            <span className="text-[11px]">Close</span>
          </Button>
        </div>
      </div>

      {/* Sparkline — sits above the scrub track. Hidden on narrow viewports
          where there isn't room for both. */}
      <div className="hidden sm:block">
        <SentimentSparkline
          buckets={buckets}
          playheadPct={playheadPct}
          width={800}
          height={56}
          className="block h-12 w-full"
        />
      </div>

      {/* Scrubber row with the floating playhead card */}
      <div className="relative mt-3 pt-12">
        <PlayheadCard
          response={currentResponse}
          persona={currentPersona}
          playheadPct={playheadPct}
        />
        <Slider
          value={[clampedPlayhead]}
          min={startMs}
          max={endMs}
          step={Math.max(1, Math.round(spanMs / 1000))}
          onValueChange={(v) => {
            // Dragging always cancels active playback.
            if (stopRef.current) stopAnimation();
            if (isPlaying) setIsPlaying(false);
            const next = v[0];
            if (typeof next === "number") onPlayheadChange(next);
          }}
          aria-label="Generation timeline scrubber"
        />
        <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
          <span>{formatTime(startMs)}</span>
          <span className="opacity-70">{formatDuration(spanMs)} total</span>
          <span>{formatTime(endMs)}</span>
        </div>
      </div>

      {/* Play controls */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => (isPlaying ? pause() : play())}
          className="h-7 gap-1.5"
          aria-pressed={isPlaying}
        >
          {isPlaying ? (
            <>
              <Pause className="h-3.5 w-3.5" />
              Pause
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              Play
            </>
          )}
        </Button>

        {/* Speed selector — three discrete options for low cognitive load. */}
        <div className="ml-1 inline-flex rounded-md border">
          {[1, 4, 16].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s as Speed)}
              className={
                "px-2.5 py-1 font-mono text-[11px] tabular-nums transition-colors " +
                (speed === s
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted/60")
              }
              aria-pressed={speed === s}
              aria-label={`Playback speed ${s}×`}
            >
              {s}×
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={reset}
          className="h-7 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const d = new Date(ms);
  // Locale-friendly short time — matches the existing app convention.
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
