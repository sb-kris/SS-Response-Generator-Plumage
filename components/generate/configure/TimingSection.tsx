"use client";

import { useGenerationStore } from "@/store/generation-store";
import type { TimeRangeConfig, TimePattern } from "@/lib/profiles/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface PatternDef {
  id: TimePattern;
  label: string;
  description: string;
  bars: number[];
}

const PATTERNS: PatternDef[] = [
  {
    id: "realistic_mix",
    label: "Realistic Mix",
    description:
      "Weighted toward recent dates, more on weekdays, business hours. Mimics a real active user base.",
    // Right-weighted with weekday/weekend waves
    bars: [4, 10, 14, 12, 9, 3, 2, 6, 14, 18, 16, 12, 4, 3, 8, 22],
  },
  {
    id: "uniform",
    label: "Uniform",
    description: "Evenly spread across the date range. Clean for showing steady adoption.",
    bars: Array<number>(16).fill(15),
  },
  {
    id: "recent_surge",
    label: "Recent Surge",
    description:
      "Most responses in the last 20% of the date range. Good for showing recent growth.",
    bars: [1, 1, 1, 2, 2, 3, 3, 4, 5, 7, 9, 12, 16, 21, 26, 30],
  },
  {
    id: "campaign_burst",
    label: "Campaign Burst",
    description:
      "Concentrated spike in the middle of the range. Simulates a survey campaign or email blast.",
    bars: [1, 3, 6, 10, 15, 21, 27, 30, 27, 21, 15, 10, 6, 3, 1, 1],
  },
];

// ---------------------------------------------------------------------------
// Slider constants
// ---------------------------------------------------------------------------

const MIN_COUNT = 10;
const MAX_COUNT = 5_000;
const SOFT_CAP = 1_000;
// Position of the soft cap marker as a percentage of the slider track.
const CAP_MARKER_PCT =
  ((SOFT_CAP - MIN_COUNT) / (MAX_COUNT - MIN_COUNT)) * 100;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function msToDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dateStrToMs(str: string): number {
  // Use T12:00:00 so UTC midnight ambiguity doesn't shift the date backward.
  return new Date(str + "T12:00:00").getTime();
}

const TWO_YEARS_AGO = msToDateStr(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
const TODAY = msToDateStr(Date.now());

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TimingSection() {
  const timeRange = useGenerationStore((s) => s.draft.timeRange);
  const setDraft = useGenerationStore((s) => s.setDraft);

  function update(patch: Partial<TimeRangeConfig>) {
    setDraft((draft) => {
      draft.timeRange = { ...draft.timeRange, ...patch };
    });
  }

  const { responseCount } = timeRange;

  const volumeWarning =
    responseCount >= MAX_COUNT
      ? {
          level: "red" as const,
          msg: "🔴 Maximum. Expect 30+ minutes and significant LLM cost.",
        }
      : responseCount >= 3_000
        ? {
            level: "orange" as const,
            msg: "⚠️ Very high volume. Recommended only for final demo environments.",
          }
        : responseCount >= SOFT_CAP
          ? {
              level: "yellow" as const,
              msg: "⚡ Generating 1,000+ responses may take 10+ minutes and cost $5+. Consider starting with 200–500 for initial demos.",
            }
          : null;

  return (
    <section id="timing" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Response Timing
          </CardTitle>
          <CardDescription>
            Spread submissions across a date range to make analytics dashboards look realistic.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* ---- Date range ---- */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Date range</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label
                  htmlFor="timing-from"
                  className="block text-xs text-muted-foreground"
                >
                  From
                </label>
                <Input
                  id="timing-from"
                  type="date"
                  value={msToDateStr(timeRange.from)}
                  min={TWO_YEARS_AGO}
                  max={msToDateStr(timeRange.to)}
                  onChange={(e) => {
                    if (e.target.value) update({ from: dateStrToMs(e.target.value) });
                  }}
                  className="h-8 text-sm"
                />
              </div>
              <span className="pb-1.5 text-muted-foreground">→</span>
              <div className="space-y-1">
                <label
                  htmlFor="timing-to"
                  className="block text-xs text-muted-foreground"
                >
                  To
                </label>
                <Input
                  id="timing-to"
                  type="date"
                  value={msToDateStr(timeRange.to)}
                  min={msToDateStr(timeRange.from)}
                  max={TODAY}
                  onChange={(e) => {
                    if (e.target.value) update({ to: dateStrToMs(e.target.value) });
                  }}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Responses will be distributed across this window based on the pattern below.
            </p>
          </div>

          {/* ---- Pattern selector ---- */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Distribution pattern</p>
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {PATTERNS.map((p) => (
                <PatternCard
                  key={p.id}
                  pattern={p}
                  selected={timeRange.pattern === p.id}
                  onSelect={() => update({ pattern: p.id })}
                />
              ))}
            </div>
          </div>

          {/* ---- Business hours ---- */}
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="business-hours"
              checked={timeRange.businessHoursWeight}
              onChange={(e) => update({ businessHoursWeight: e.target.checked })}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border accent-primary"
            />
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    htmlFor="business-hours"
                    className="cursor-pointer text-sm font-medium"
                  >
                    Weight toward business hours (9am–6pm, Mon–Fri) in persona&apos;s
                    timezone
                  </label>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  When enabled, fewer responses appear at 2am or on weekends. Mirrors
                  real survey response behavior.
                </TooltipContent>
              </Tooltip>
              <p className="text-xs text-muted-foreground">
                Fewer responses at night and on weekends — mirrors real user behavior.
              </p>
            </div>
          </div>

          {/* ---- Volume slider ---- */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Number of responses</p>
              <input
                type="number"
                value={responseCount}
                min={MIN_COUNT}
                max={MAX_COUNT}
                step={10}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) {
                    update({
                      responseCount: Math.max(MIN_COUNT, Math.min(MAX_COUNT, v)),
                    });
                  }
                }}
                className="h-7 w-20 rounded-md border bg-background px-2 text-right tabular-nums text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Slider + soft cap marker */}
            <div className="relative">
              <Slider
                value={[responseCount]}
                onValueChange={(values) => {
                  const v = values[0];
                  if (typeof v === "number") update({ responseCount: v });
                }}
                min={MIN_COUNT}
                max={MAX_COUNT}
                step={10}
                aria-label="Number of responses"
              />
              {/* Soft cap tick at 1,000 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 cursor-default rounded-full bg-warning/70 pointer-events-auto"
                    style={{ left: `${CAP_MARKER_PCT}%` }}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">1,000 response soft cap</TooltipContent>
              </Tooltip>
            </div>

            {/* Volume warning */}
            {volumeWarning && (
              <div
                className={cn(
                  "rounded-md border p-2.5 text-xs leading-relaxed",
                  volumeWarning.level === "red" &&
                    "border-destructive/40 bg-destructive/10 text-destructive",
                  volumeWarning.level === "orange" &&
                    "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
                  volumeWarning.level === "yellow" &&
                    "border-warning/40 bg-warning/10 text-warning",
                )}
              >
                {volumeWarning.msg}
              </div>
            )}

            {/* Persona / response readouts */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>
                Estimated personas:{" "}
                <strong className="tabular-nums text-foreground">
                  {responseCount.toLocaleString()}
                </strong>
              </span>
              <span>
                Estimated responses:{" "}
                <strong className="tabular-nums text-foreground">
                  {responseCount.toLocaleString()}
                </strong>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pattern card
// ---------------------------------------------------------------------------

function PatternCard({
  pattern,
  selected,
  onSelect,
}: {
  pattern: PatternDef;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "hover:border-muted-foreground/40 hover:bg-muted/30",
      )}
      aria-pressed={selected}
    >
      <Histogram bars={pattern.bars} selected={selected} />
      <div>
        <p className="text-xs font-semibold leading-tight">{pattern.label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
          {pattern.description}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SVG histogram
// ---------------------------------------------------------------------------

function Histogram({ bars, selected }: { bars: number[]; selected: boolean }) {
  const BAR_W = 4;
  const GAP = 1;
  const MAX_H = 30;
  const svgW = bars.length * (BAR_W + GAP) - GAP;

  return (
    <svg
      viewBox={`0 0 ${svgW} ${MAX_H}`}
      width={svgW}
      height={MAX_H}
      aria-hidden
      className={cn(
        "shrink-0",
        selected ? "text-primary" : "text-muted-foreground/60",
      )}
    >
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * (BAR_W + GAP)}
          y={MAX_H - h}
          width={BAR_W}
          height={h}
          fill="currentColor"
          rx="0.5"
        />
      ))}
    </svg>
  );
}
