"use client";

import { useMemo } from "react";
import type { SentimentBucket } from "@/lib/timeline/buckets";

interface Props {
  buckets: SentimentBucket[];
  /** Playhead position in [0, 1] — used to render the vertical scrub line. */
  playheadPct: number;
  width?: number;
  height?: number;
  className?: string;
}

// Stacked-area sparkline for sentiment over time.
//
// Why custom SVG: 30 points, three series. Recharts would be heavier than
// the chart needs to be. Three <path> elements with a precomputed `d`
// string render in microseconds and adapt to theme colours via CSS vars.
//
// Layout: bands are stacked bottom-up in promoter → passive → detractor
// order. Each band is rendered as a closed polygon: bottom edge along the
// running lower bound, top edge along the running cumulative count.
//
// Colours: derive from the theme's `--success`, `--muted-foreground`, and
// `--destructive` variables so the chart re-tints with each theme switch.
// We deliberately don't use `--primary` here — the chart is sentiment-
// semantic, not brand-semantic.
export function SentimentSparkline({
  buckets,
  playheadPct,
  width = 100,
  height = 100,
  className,
}: Props) {
  const paths = useMemo(() => buildPaths(buckets, width, height), [buckets, width, height]);

  if (buckets.length === 0 || paths.maxY === 0) {
    return null;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label="Sentiment distribution over time"
    >
      {/* Promoter band — bottom of the stack, brightest */}
      <path d={paths.promoter} fill="hsl(var(--success))" fillOpacity={0.55} />
      {/* Passive band — middle, muted */}
      <path d={paths.passive} fill="hsl(var(--muted-foreground))" fillOpacity={0.45} />
      {/* Detractor band — top, destructive */}
      <path d={paths.detractor} fill="hsl(var(--destructive))" fillOpacity={0.55} />

      {/* Playhead vertical line — primary accent so it pops against the
          sentiment bands. Drawn last so it sits above the areas. */}
      <line
        x1={playheadPct * width}
        x2={playheadPct * width}
        y1={0}
        y2={height}
        stroke="hsl(var(--primary))"
        strokeWidth={1.25}
        strokeDasharray="2,2"
        opacity={0.85}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

interface BandPaths {
  promoter: string;
  passive: string;
  detractor: string;
  maxY: number;
}

function buildPaths(buckets: SentimentBucket[], w: number, h: number): BandPaths {
  if (buckets.length === 0) {
    return { promoter: "", passive: "", detractor: "", maxY: 0 };
  }

  // Y-scale based on the maximum cumulative total across all buckets — the
  // final bucket's total in a monotonically growing series.
  const maxY = buckets[buckets.length - 1]!.cumTotal;
  if (maxY === 0) {
    return { promoter: "", passive: "", detractor: "", maxY: 0 };
  }

  const xStep = w / (buckets.length - 1 || 1);

  // For each band, the top edge follows the running sum *up to and
  // including* that band; the bottom edge follows the band beneath.
  // Stacking order from bottom of chart upward: promoter, passive, detractor.
  const yPromoTop = buckets.map((b) => h - (b.cumPromoter / maxY) * h);
  const yPassiveTop = buckets.map(
    (b) => h - ((b.cumPromoter + b.cumPassive) / maxY) * h,
  );
  const yDetTop = buckets.map(
    (b) => h - ((b.cumPromoter + b.cumPassive + b.cumDetractor) / maxY) * h,
  );

  function band(topYs: number[], bottomYs: number[]): string {
    const pts: string[] = [];
    pts.push(`M 0 ${topYs[0]!.toFixed(2)}`);
    for (let i = 1; i < topYs.length; i++) {
      pts.push(`L ${(i * xStep).toFixed(2)} ${topYs[i]!.toFixed(2)}`);
    }
    // Close along the bottom edge in reverse to form a polygon.
    for (let i = bottomYs.length - 1; i >= 0; i--) {
      pts.push(`L ${(i * xStep).toFixed(2)} ${bottomYs[i]!.toFixed(2)}`);
    }
    pts.push("Z");
    return pts.join(" ");
  }

  const bottom = new Array(buckets.length).fill(h);

  return {
    promoter: band(yPromoTop, bottom),
    passive: band(yPassiveTop, yPromoTop),
    detractor: band(yDetTop, yPassiveTop),
    maxY,
  };
}
