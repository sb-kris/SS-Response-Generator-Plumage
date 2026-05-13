"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { useGenerationStore } from "@/store/generation-store";
import {
  PERSONA_KEYS,
  PERSONA_PRESETS,
  rebalance,
  roundDistribution,
  type LockState,
  type PersonaKey,
} from "@/lib/profiles/persona-distribution";
import type { PersonaDistribution } from "@/lib/profiles/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Lock, Unlock, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const ANIMATION_MS = 320;

interface ArchetypeMeta {
  key: PersonaKey;
  label: string;
  description: string;
  /** CSS color for slider range, pie wedge, badge accent. */
  color: string;
}

const ARCHETYPES: ArchetypeMeta[] = [
  {
    key: "promoter",
    label: "Promoters",
    description: "Enthusiastic, rate high, write glowing comments.",
    color: "hsl(var(--success))",
  },
  {
    key: "passive",
    label: "Passives",
    description: "Neutral, rate middling, write short or noncommittal text.",
    color: "hsl(var(--muted-foreground))",
  },
  {
    key: "detractor",
    label: "Detractors",
    description: "Frustrated, rate low, complain in detail.",
    color: "hsl(var(--destructive))",
  },
];

export function PersonasSection() {
  const distribution = useGenerationStore((s) => s.draft.personaDistribution);
  const setDraft = useGenerationStore((s) => s.setDraft);

  // Locks are session-only UX; we don't persist them in the profile schema.
  const [locks, setLocks] = useState<LockState>({
    promoter: false,
    passive: false,
    detractor: false,
  });

  // Animation handle (used for preset transitions). Cancelled on unmount or
  // on direct user input.
  const animationRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  function cancelAnimation() {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }

  function applyDistribution(next: PersonaDistribution) {
    setDraft((draft) => {
      draft.personaDistribution = next;
    });
  }

  function handleSliderChange(key: PersonaKey, requested: number) {
    cancelAnimation();
    const next = rebalance(distribution, locks, key, requested);
    applyDistribution(next);
  }

  function handleNumericInput(key: PersonaKey, raw: string) {
    if (raw === "") {
      handleSliderChange(key, 0);
      return;
    }
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      handleSliderChange(key, Math.max(0, Math.min(100, parsed)));
    }
  }

  function toggleLock(key: PersonaKey) {
    setLocks((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function applyPreset(preset: PersonaDistribution) {
    cancelAnimation();
    const start = { ...distribution };
    const target = roundDistribution(preset);

    // Don't animate if we're already at the target (button feels broken otherwise).
    if (
      start.promoter === target.promoter &&
      start.passive === target.passive &&
      start.detractor === target.detractor
    ) {
      return;
    }

    const startTime = performance.now();
    function step() {
      const now = performance.now();
      const t = Math.min(1, (now - startTime) / ANIMATION_MS);
      const eased = easeOutCubic(t);
      const interpolated: PersonaDistribution = {
        promoter: lerp(start.promoter, target.promoter, eased),
        passive: lerp(start.passive, target.passive, eased),
        detractor: lerp(start.detractor, target.detractor, eased),
      };
      applyDistribution(roundDistribution(interpolated));
      if (t < 1) {
        animationRef.current = requestAnimationFrame(step);
      } else {
        animationRef.current = null;
      }
    }

    animationRef.current = requestAnimationFrame(step);
  }

  const sum = distribution.promoter + distribution.passive + distribution.detractor;

  // Recharts data — memoized so the chart only animates when the values
  // actually change.
  const chartData = useMemo(
    () =>
      ARCHETYPES.map((a) => ({
        key: a.key,
        name: a.label,
        value: distribution[a.key],
        color: a.color,
      })),
    [distribution],
  );

  const lockedCount = Object.values(locks).filter(Boolean).length;
  const matchingPresetId = useMemo(() => {
    return PERSONA_PRESETS.find(
      (p) =>
        p.distribution.promoter === distribution.promoter &&
        p.distribution.passive === distribution.passive &&
        p.distribution.detractor === distribution.detractor,
    )?.id;
  }, [distribution]);

  return (
    <section id="personas" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" />
                Persona distribution
                <SumBadge sum={sum} />
              </CardTitle>
              <CardDescription>
                Sentiment mix for synthetic respondents. Drag a slider — the
                others auto-balance to keep the total at 100%. Lock a slider to
                pin its value while you adjust the rest.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Smart presets */}
          <div className="flex flex-wrap gap-2">
            {PERSONA_PRESETS.map((preset) => {
              const active = matchingPresetId === preset.id;
              return (
                <Tooltip key={preset.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => applyPreset(preset.distribution)}
                      className={cn(
                        "flex flex-col items-start rounded-md border bg-background px-3 py-2 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/5"
                          : "hover:border-input hover:bg-accent",
                      )}
                    >
                      <span className="text-sm font-medium">{preset.label}</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {preset.distribution.promoter}/
                        {preset.distribution.passive}/
                        {preset.distribution.detractor}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {preset.description}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Sliders + Pie chart */}
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-3">
              {ARCHETYPES.map((a) => (
                <PersonaRow
                  key={a.key}
                  meta={a}
                  value={distribution[a.key]}
                  locked={locks[a.key]}
                  disabled={false}
                  onSlider={(v) => handleSliderChange(a.key, v)}
                  onInput={(raw) => handleNumericInput(a.key, raw)}
                  onToggleLock={() => toggleLock(a.key)}
                />
              ))}
              {lockedCount === PERSONA_KEYS.length && (
                <p className="text-xs text-warning">
                  All sliders locked — unlock at least one to make changes.
                </p>
              )}
            </div>

            <div className="mx-auto w-full max-w-[220px]">
              <DistributionPie data={chartData} />
            </div>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              For NPS demos, weight more <strong>Promoters</strong> (60–70%).
              For recovery demos, increase <strong>Detractors</strong>. Custom
              archetypes will land in a future update.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PersonaRow
// ---------------------------------------------------------------------------

interface PersonaRowProps {
  meta: ArchetypeMeta;
  value: number;
  locked: boolean;
  disabled: boolean;
  onSlider: (value: number) => void;
  onInput: (raw: string) => void;
  onToggleLock: () => void;
}

function PersonaRow({
  meta,
  value,
  locked,
  disabled,
  onSlider,
  onInput,
  onToggleLock,
}: PersonaRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: meta.color }}
          />
          <span className="text-sm font-medium">{meta.label}</span>
          <span className="text-xs text-muted-foreground">
            · {meta.description}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleLock}
                aria-label={locked ? `Unlock ${meta.label}` : `Lock ${meta.label}`}
                aria-pressed={locked}
                className={cn(
                  "h-7 w-7",
                  locked
                    ? "text-warning hover:text-warning"
                    : "text-muted-foreground",
                )}
              >
                {locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              {locked
                ? "Locked — won't auto-adjust when other sliders change."
                : "Click to lock — value won't change when other sliders move."}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Slider
          value={[value]}
          onValueChange={(values) => {
            const v = values[0];
            if (typeof v === "number") onSlider(v);
          }}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          rangeColor={meta.color}
          aria-label={`${meta.label} percentage`}
        />
        <div className="flex items-center gap-1">
          <Input
            type="number"
            inputMode="numeric"
            value={value}
            onChange={(e) => onInput(e.target.value)}
            min={0}
            max={100}
            className="h-8 w-16 px-2 text-right tabular-nums"
            disabled={disabled}
            aria-label={`${meta.label} numeric value`}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DistributionPie
// ---------------------------------------------------------------------------

interface PieDatum {
  key: PersonaKey;
  name: string;
  value: number;
  color: string;
}

function DistributionPie({ data }: { data: PieDatum[] }) {
  return (
    <div
      className="aspect-square w-full"
      // Recharts produces SVGs that respect aria — we still tag the wrapper
      // for screen readers since the chart conveys the same data the sliders
      // already announce.
      role="img"
      aria-label="Persona distribution chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius="60%"
            outerRadius="90%"
            paddingAngle={2}
            isAnimationActive={false}
            stroke="hsl(var(--background))"
            strokeWidth={2}
          >
            {data.map((entry) => (
              <Cell key={entry.key} fill={entry.color} />
            ))}
          </Pie>
          <RechartsTooltip
            cursor={{ fill: "transparent" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "0.375rem",
              fontSize: "0.75rem",
              padding: "6px 10px",
              color: "hsl(var(--popover-foreground))",
            }}
            formatter={(value, name) => [`${String(value)}%`, name]}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sum badge — turns warning if not exactly 100 (rare, but defensive).
// ---------------------------------------------------------------------------

function SumBadge({ sum }: { sum: number }) {
  const ok = sum === 100;
  return (
    <Badge
      variant={ok ? "outline" : "warning"}
      className="font-mono tabular-nums"
    >
      {ok ? "100%" : `${sum}%`}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
