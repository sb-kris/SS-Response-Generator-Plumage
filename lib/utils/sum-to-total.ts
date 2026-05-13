// Generic sum-to-total redistribution helper.
//
// Used by both the language slider section (3c) and any future N-key weighted
// distribution. The persona helper ([lib/profiles/persona-distribution.ts])
// stays as-is because it's hard-coded to three keys with named accessors and
// already covered by 3b's tests.
//
// Behavior:
// - All values are integers in [0, total].
// - The values always sum to exactly `total` (default 100).
// - Changing one key proportionally redistributes the delta across other
//   unlocked keys.
// - Locked keys never auto-adjust. If the user drags a locked key directly
//   it still moves — locks only affect *auto*-redistribution.
// - If every other key is locked, the changed key is clamped so the sum
//   constraint still holds.

export interface WeightedItem {
  key: string;
  value: number;
}

export type LockSet = ReadonlySet<string>;

/**
 * Apply a user-requested change to one key, redistributing the delta across
 * other unlocked keys. Returns a new array with the same key order.
 */
export function rebalanceToTotal(
  items: WeightedItem[],
  changedKey: string,
  requestedValue: number,
  locks: LockSet,
  total = 100,
): WeightedItem[] {
  if (items.length === 0) return items;
  // If the changed key isn't in the list, no-op.
  if (!items.some((i) => i.key === changedKey)) return items;

  const others = items.filter((i) => i.key !== changedKey);
  const lockedOthers = others.filter((i) => locks.has(i.key));
  const flexibleOthers = others.filter((i) => !locks.has(i.key));
  const lockedSum = lockedOthers.reduce((s, i) => s + i.value, 0);
  const maxValue = total - lockedSum;
  const clamped = clamp(requestedValue, 0, maxValue);
  const remaining = total - lockedSum - clamped;

  const valueByKey: Record<string, number> = {};
  for (const i of items) valueByKey[i.key] = i.value;
  valueByKey[changedKey] = clamped;
  for (const lk of lockedOthers) valueByKey[lk.key] = lk.value;

  if (flexibleOthers.length === 0) {
    return roundToTotal(items.map((i) => ({ ...i, value: valueByKey[i.key]! })), total);
  }

  const flexibleSum = flexibleOthers.reduce((s, i) => s + i.value, 0);
  if (flexibleSum === 0) {
    // No prior weight to scale — split the remaining budget evenly.
    const per = remaining / flexibleOthers.length;
    for (const fk of flexibleOthers) valueByKey[fk.key] = per;
  } else {
    for (const fk of flexibleOthers) {
      valueByKey[fk.key] = (fk.value / flexibleSum) * remaining;
    }
  }

  return roundToTotal(
    items.map((i) => ({ ...i, value: valueByKey[i.key]! })),
    total,
  );
}

/**
 * Round all values to integers and absorb any rounding error in the LARGEST
 * non-locked field so the sum is exactly `total`. Locked fields are kept
 * intact (they were already integers).
 */
export function roundToTotal(
  items: WeightedItem[],
  total = 100,
  locks: LockSet = EMPTY_SET,
): WeightedItem[] {
  const rounded = items.map((i) => ({
    ...i,
    value: Math.max(0, Math.round(i.value)),
  }));
  const sum = rounded.reduce((s, i) => s + i.value, 0);
  const diff = total - sum;
  if (diff === 0) return rounded;

  // Pick the largest unlocked field to absorb the difference. If all are
  // locked, fall back to the largest field overall.
  const candidates = rounded.filter((i) => !locks.has(i.key));
  const pool = candidates.length > 0 ? candidates : rounded;
  let target: WeightedItem | undefined;
  for (const item of pool) {
    if (!target || item.value > target.value) target = item;
  }
  if (!target) return rounded;

  return rounded.map((i) =>
    i.key === target!.key ? { ...i, value: clamp(i.value + diff, 0, total) } : i,
  );
}

/**
 * Distribute `total` evenly across the given keys, respecting locks.
 * Locked keys keep their current value; the rest split the remaining budget.
 */
export function distributeEvenly(
  items: WeightedItem[],
  locks: LockSet,
  total = 100,
): WeightedItem[] {
  if (items.length === 0) return items;
  const lockedSum = items
    .filter((i) => locks.has(i.key))
    .reduce((s, i) => s + i.value, 0);
  const flexible = items.filter((i) => !locks.has(i.key));
  if (flexible.length === 0) return items; // Everything locked — no-op.
  const remaining = Math.max(0, total - lockedSum);
  const per = remaining / flexible.length;
  return roundToTotal(
    items.map((i) =>
      locks.has(i.key) ? i : { ...i, value: per },
    ),
    total,
    locks,
  );
}

/**
 * Remove a key. Its value is redistributed proportionally across the remaining
 * unlocked items. If everything else is locked, the value is dumped on a
 * preferred key (typically English for languages); if even that is locked,
 * the whole list is force-renormalized to `total`.
 */
export function removeKeyAndRedistribute(
  items: WeightedItem[],
  removedKey: string,
  locks: LockSet,
  preferredFallbackKey?: string,
  total = 100,
): WeightedItem[] {
  const removed = items.find((i) => i.key === removedKey);
  if (!removed) return items;
  const remaining = items.filter((i) => i.key !== removedKey);
  if (remaining.length === 0) return remaining;

  const flexibleRemaining = remaining.filter((i) => !locks.has(i.key));
  const targets =
    flexibleRemaining.length > 0
      ? flexibleRemaining
      : preferredFallbackKey
        ? remaining.filter((i) => i.key === preferredFallbackKey)
        : remaining;

  const targetSum = targets.reduce((s, i) => s + i.value, 0);
  const updated = remaining.map((i) => {
    if (!targets.includes(i)) return i;
    if (targetSum === 0) {
      return { ...i, value: i.value + removed.value / targets.length };
    }
    return { ...i, value: i.value + (i.value / targetSum) * removed.value };
  });

  return roundToTotal(updated, total, locks);
}

const EMPTY_SET: LockSet = new Set<string>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
