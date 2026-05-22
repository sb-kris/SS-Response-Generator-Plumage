"use client";

import { useMemo, useState, useCallback } from "react";

// Lightweight sort + filter state for the persona/responses tables.
//
// Why a hand-rolled hook instead of TanStack Table:
//   - The tables are simple — a flat list, no sub-rows, no column visibility,
//     no resizing. TanStack would add ~10 KB gzipped for capabilities we
//     don't use.
//   - We want the sort/filter UX to match the rest of the app exactly
//     (eyebrow text, pill row, chevron indicators). A hook keeps the
//     visual treatment in our own components.
//   - O(N log N) sort on a 500-item array runs in <1 ms in modern V8 —
//     fast enough that we don't need virtualization or memoised cursors.
//
// SECURITY: no data leaves this hook; all sorting/filtering is in-memory.

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K | null;
  /** Direction is meaningful only when `key` is non-null. */
  direction: SortDirection;
}

/** Comparator that returns a number; matches Array.sort's contract. */
export type Comparator<T> = (a: T, b: T) => number;

export interface SortColumn<T, K extends string> {
  key: K;
  /** Reads the comparable value off a row. Strings sort case-insensitively. */
  accessor: (row: T) => string | number | null | undefined;
}

/**
 * Returns sort state + a `toggleSort` callback. Clicking a column header:
 *   - first time: sorts ascending by that key
 *   - second click on same key: flips to descending
 *   - third click on same key: clears the sort (back to natural order)
 *
 * This three-state cycle matches the convention in tools like Linear and
 * Notion — feels familiar without needing a tooltip.
 */
export function useColumnSort<T, K extends string>(
  columns: ReadonlyArray<SortColumn<T, K>>,
  /** Default sort applied on mount. `null` = natural row order. */
  initial: SortState<K> = { key: null, direction: "asc" },
): {
  sort: SortState<K>;
  toggleSort: (key: K) => void;
  sortRows: (rows: T[]) => T[];
} {
  const [sort, setSort] = useState<SortState<K>>(initial);

  const toggleSort = useCallback((key: K) => {
    setSort((cur) => {
      if (cur.key !== key) return { key, direction: "asc" };
      if (cur.direction === "asc") return { key, direction: "desc" };
      // Was desc on this key → clear.
      return { key: null, direction: "asc" };
    });
  }, []);

  const columnMap = useMemo(() => {
    const m = new Map<K, SortColumn<T, K>>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);

  const sortRows = useCallback(
    (rows: T[]): T[] => {
      if (!sort.key) return rows;
      const col = columnMap.get(sort.key);
      if (!col) return rows;
      const dir = sort.direction === "asc" ? 1 : -1;
      // Stable sort + tolerant comparator. Nullish values land at the
      // bottom regardless of direction so the user always sees populated
      // rows first.
      return [...rows].sort((a, b) => {
        const av = col.accessor(a);
        const bv = col.accessor(b);
        const aMissing = av == null || av === "";
        const bMissing = bv == null || bv === "";
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (typeof av === "number" && typeof bv === "number") {
          return dir * (av - bv);
        }
        // Locale-aware case-insensitive string compare.
        return dir * String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
      });
    },
    [sort, columnMap],
  );

  return { sort, toggleSort, sortRows };
}

/**
 * Single-value filter state with an "all" sentinel. Used for sentiment,
 * verbosity, and language filters above the table.
 */
export function useSingleFilter<V extends string>(): {
  value: V | "all";
  setValue: (v: V | "all") => void;
  match: (rowValue: V | null | undefined) => boolean;
} {
  const [value, setValue] = useState<V | "all">("all");
  const match = useCallback(
    (rowValue: V | null | undefined): boolean => {
      if (value === "all") return true;
      return rowValue === value;
    },
    [value],
  );
  return { value, setValue, match };
}
