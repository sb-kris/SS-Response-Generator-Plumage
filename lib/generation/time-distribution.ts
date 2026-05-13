// Distribute N submission timestamps across a date range using one of the
// four configured patterns. The output is a sorted array of Date objects
// (ascending), one per persona. The Faker layer pairs them up with personas
// after generation.
//
// All four patterns produce the same shape — an array of Dates — but the
// underlying distribution differs:
//   - uniform        : even spread
//   - realistic_mix  : slight right-weight (more recent), business-hours optional
//   - recent_surge   : exponential tail toward `to`
//   - campaign_burst : bell curve centered in the range
//
// Jitter is added per timestamp so submissions don't fall exactly on the
// minute boundary. Business-hours weighting applies only to `realistic_mix`
// per the Phase 3g spec.

import type { TimeRangeConfig, TimePattern } from "@/lib/profiles/types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateTimestamps(count: number, config: TimeRangeConfig): Date[] {
  if (count <= 0) return [];
  const { from, to, pattern, businessHoursWeight } = config;
  // Defensive: if `from > to`, swap.
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) {
    return Array.from({ length: count }, () => new Date(start));
  }

  let raw: number[];
  switch (pattern) {
    case "uniform":
      raw = uniform(start, end, count);
      break;
    case "recent_surge":
      raw = exponentialRight(start, end, count);
      break;
    case "campaign_burst":
      raw = bellCurve(start, end, count);
      break;
    case "realistic_mix":
    default:
      raw = realisticMix(start, end, count);
  }

  // Jitter ±15 minutes so nothing lands exactly on a clock minute.
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;
  const jittered = raw.map((t) => t + (Math.random() - 0.5) * 2 * FIFTEEN_MIN_MS);

  // Business-hours bias: rebias each timestamp toward Mon-Fri 9am-6pm in UTC.
  // We don't know the persona's local timezone yet (assigned later), so this
  // is a UTC-relative bias — close enough for demo dashboards.
  const biased = businessHoursWeight && pattern === "realistic_mix"
    ? jittered.map((t) => biasTowardBusinessHours(t, start, end))
    : jittered;

  // Clamp to [start, end] then sort ascending.
  return biased
    .map((t) => new Date(Math.max(start, Math.min(end, t))))
    .sort((a, b) => a.getTime() - b.getTime());
}

// ---------------------------------------------------------------------------
// Pattern implementations
// ---------------------------------------------------------------------------

function uniform(start: number, end: number, n: number): number[] {
  const span = end - start;
  return Array.from({ length: n }, () => start + Math.random() * span);
}

/** Exponential decay from `end` backward — more weight on recent dates. */
function exponentialRight(start: number, end: number, n: number): number[] {
  const span = end - start;
  // Use inverse-CDF sampling on f(x) = λ e^{-λx} on [0,1] reversed.
  // λ controls how steeply weighted toward `end` — 4 gives ~80% in last 25%.
  const lambda = 4;
  return Array.from({ length: n }, () => {
    const u = Math.random();
    const x = -Math.log(1 - u * (1 - Math.exp(-lambda))) / lambda; // x in [0,1]
    return end - x * span;
  });
}

/** Bell curve centered at the midpoint of the range. */
function bellCurve(start: number, end: number, n: number): number[] {
  const center = (start + end) / 2;
  const span = end - start;
  // Stddev ~1/6 of span so ±3σ ≈ full range. Clamping happens in the caller.
  const sigma = span / 6;
  return Array.from({ length: n }, () => center + boxMuller() * sigma);
}

/**
 * Right-weighted with weekday bias. Combines:
 *   - 60% exponential-right (recent skew)
 *   - 40% uniform (so the early range still has some volume)
 */
function realisticMix(start: number, end: number, n: number): number[] {
  const out: number[] = [];
  const exponentialN = Math.round(n * 0.6);
  const uniformN = n - exponentialN;
  out.push(...exponentialRight(start, end, exponentialN));
  out.push(...uniform(start, end, uniformN));
  return out;
}

// ---------------------------------------------------------------------------
// Business-hours bias
// ---------------------------------------------------------------------------

/**
 * If `t` lands on a weekend or outside 9-18 UTC, with probability 0.6 nudge
 * it onto a nearby weekday business hour. We don't move every off-hours
 * sample — leaving some keeps the distribution realistic (real users do
 * answer surveys at 11pm sometimes). Only used by `realistic_mix`.
 */
function biasTowardBusinessHours(t: number, start: number, end: number): number {
  const d = new Date(t);
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  const hour = d.getUTCHours();
  const isWeekend = day === 0 || day === 6;
  const isOffHours = hour < 9 || hour >= 18;
  if (!isWeekend && !isOffHours) return t;

  // 60% chance to bias; 40% chance to keep the off-hours sample.
  if (Math.random() > 0.6) return t;

  // Find the nearest weekday and pick a random business hour on it.
  const candidate = new Date(d);
  if (day === 0) candidate.setUTCDate(d.getUTCDate() + 1); // Sun -> Mon
  else if (day === 6) candidate.setUTCDate(d.getUTCDate() - 1); // Sat -> Fri
  candidate.setUTCHours(9 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60));
  const ms = candidate.getTime();
  // Stay within the configured range.
  return Math.max(start, Math.min(end, ms));
}

// ---------------------------------------------------------------------------
// Box-Muller transform for normal samples (μ=0, σ=1)
// ---------------------------------------------------------------------------

function boxMuller(): number {
  const u1 = Math.random() || Number.MIN_VALUE; // avoid log(0)
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Re-export for tests / debugging
// ---------------------------------------------------------------------------

export const _internal = {
  uniform,
  exponentialRight,
  bellCurve,
  realisticMix,
  biasTowardBusinessHours,
};

// `TimePattern` is re-exported here so consumers don't need to reach into
// `profiles/types`. Keeps the import surface clean.
export type { TimePattern };
