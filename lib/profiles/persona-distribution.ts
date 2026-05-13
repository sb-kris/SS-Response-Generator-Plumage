// Lock-aware redistribution helper for the persona-distribution sliders.
//
// Invariants the UI guarantees by going through this helper:
// - All three values are integers in [0, 100].
// - The three values always sum to exactly 100.
// - When the user changes one value, the other unlocked values are
//   redistributed proportionally to absorb the delta.
// - Locked values never change unless the user moves them directly.
// - If both other values are locked, the changed value is clamped so the sum
//   constraint still holds.

import type { PersonaDistribution } from "@/lib/profiles/types";

export type PersonaKey = "promoter" | "passive" | "detractor";

export type LockState = Record<PersonaKey, boolean>;

export const PERSONA_KEYS: PersonaKey[] = ["promoter", "passive", "detractor"];

/**
 * Apply a user-requested change to one persona slider, redistributing the
 * delta across the other unlocked sliders.
 */
export function rebalance(
  current: PersonaDistribution,
  locks: LockState,
  changedKey: PersonaKey,
  requestedValue: number,
): PersonaDistribution {
  const otherKeys = PERSONA_KEYS.filter((k) => k !== changedKey);
  const lockedOthers = otherKeys.filter((k) => locks[k]);
  const flexibleOthers = otherKeys.filter((k) => !locks[k]);
  const lockedSum = lockedOthers.reduce((sum, k) => sum + current[k], 0);

  // The changed value can't go beyond what locks allow.
  const maxValue = 100 - lockedSum;
  const clamped = clamp(requestedValue, 0, maxValue);

  // Whatever's left after the changed value + locked others is the budget
  // for the unlocked others.
  const remaining = 100 - lockedSum - clamped;

  const next: PersonaDistribution = { ...current, [changedKey]: clamped };

  if (flexibleOthers.length === 0) {
    return roundDistribution(next);
  }

  const flexibleSum = flexibleOthers.reduce((sum, k) => sum + current[k], 0);
  if (flexibleSum === 0) {
    // Equal split when nothing was there to scale.
    const per = remaining / flexibleOthers.length;
    flexibleOthers.forEach((k) => {
      next[k] = per;
    });
  } else {
    flexibleOthers.forEach((k) => {
      next[k] = (current[k] / flexibleSum) * remaining;
    });
  }

  return roundDistribution(next);
}

/**
 * Replace all three values at once (used for presets and animated transitions).
 * Normalizes the result so the sum is 100 even if the input wasn't quite there.
 */
export function setAll(input: PersonaDistribution): PersonaDistribution {
  return roundDistribution(input);
}

/**
 * Round to integers and absorb any rounding error in the largest field so the
 * three values always sum to exactly 100.
 */
export function roundDistribution(d: PersonaDistribution): PersonaDistribution {
  const promoter = Math.max(0, Math.round(d.promoter));
  const passive = Math.max(0, Math.round(d.passive));
  const detractor = Math.max(0, Math.round(d.detractor));
  const sum = promoter + passive + detractor;
  if (sum === 100) return { promoter, passive, detractor };

  const diff = 100 - sum;
  // Bias the rounding error to the largest field so small fields don't flicker.
  const result = { promoter, passive, detractor };
  let largestKey: PersonaKey = "promoter";
  for (const k of PERSONA_KEYS) {
    if (result[k] > result[largestKey]) largestKey = k;
  }
  result[largestKey] = Math.max(0, result[largestKey] + diff);
  // Final safety: if pushing diff into the largest field overshoots [0, 100],
  // re-distribute among the others.
  if (result[largestKey] > 100) {
    const overflow = result[largestKey] - 100;
    result[largestKey] = 100;
    const others = PERSONA_KEYS.filter((k) => k !== largestKey);
    if (others[0]) result[others[0]] = Math.max(0, result[others[0]] + overflow);
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Smart presets exposed to the UI.
export const PERSONA_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  distribution: PersonaDistribution;
}> = [
  {
    id: "healthy",
    label: "Healthy mix",
    description: "Default — realistic baseline distribution.",
    distribution: { promoter: 60, passive: 25, detractor: 15 },
  },
  {
    id: "nps",
    label: "NPS-focused",
    description: "Skewed toward Promoters for upbeat NPS demos.",
    distribution: { promoter: 70, passive: 20, detractor: 10 },
  },
  {
    id: "recovery",
    label: "Recovery scenario",
    description: "More Detractors — for showing pain points + recovery flows.",
    distribution: { promoter: 30, passive: 30, detractor: 40 },
  },
  {
    id: "polarized",
    label: "Polarized",
    description: "Loud advocates and loud critics, few neutrals.",
    distribution: { promoter: 45, passive: 10, detractor: 45 },
  },
];
