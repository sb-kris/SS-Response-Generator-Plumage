"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortState } from "./useTableControls";

// Visual primitives for the sortable / filterable tables.
//
// Two pieces:
//   - SortHeader: a clickable <th> with a subtle arrow indicator.
//   - FilterChips: a horizontal pill row above the table for single-select
//     filters (sentiment / verbosity / language).
//
// Why these are pure components: they own zero state. The parent owns the
// sort + filter state via useTableControls and passes it down. Keeps the
// parent's data flow visible in one place — no detached "magic" widgets.

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

interface SortHeaderProps<K extends string> {
  columnKey: K;
  sort: SortState<K>;
  toggle: (k: K) => void;
  children: React.ReactNode;
  /** When true, the header is rendered as plain text (no click handler).
   *  Used for non-sortable columns like "Top concern" or expander cells. */
  disabled?: boolean;
  /** Optional className passed to the <th>. Lets callers tweak width/align. */
  className?: string;
  /** Right-aligned numeric columns benefit from arrow-on-left layout. */
  align?: "left" | "right";
}

export function SortHeader<K extends string>({
  columnKey,
  sort,
  toggle,
  children,
  disabled,
  className,
  align = "left",
}: SortHeaderProps<K>) {
  const isActive = sort.key === columnKey;
  const Icon = !isActive ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  // Inactive icon is very faint — it appears only on hover so the column
  // header doesn't feel cluttered when no sort is applied. Tailwind's
  // group-hover pattern keeps the CSS lean.
  const iconClass = cn(
    "h-3 w-3 shrink-0 transition-opacity",
    isActive ? "opacity-100 text-foreground" : "opacity-0 group-hover:opacity-50",
  );

  if (disabled) {
    return (
      <th className={cn("px-3 py-2 text-left font-medium", className)}>
        <span className="inline-flex items-center">{children}</span>
      </th>
    );
  }

  return (
    <th
      className={cn(
        "px-3 py-2 font-medium select-none",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => toggle(columnKey)}
        className={cn(
          "group inline-flex items-center gap-1.5 rounded px-1 -mx-1 transition-colors",
          "hover:text-foreground hover:bg-muted/60 focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
        aria-label={`Sort by ${typeof children === "string" ? children : columnKey} ${
          isActive ? (sort.direction === "asc" ? "descending" : "clear sort") : "ascending"
        }`}
      >
        <span>{children}</span>
        <Icon className={iconClass} />
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Filter chip row
// ---------------------------------------------------------------------------

export interface FilterOption<V extends string> {
  value: V | "all";
  label: string;
  /** Optional count to show alongside the label (e.g. "Promoter · 230"). */
  count?: number;
  /** Optional tint for the active chip — matches the badge colour scheme. */
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

interface FilterChipsProps<V extends string> {
  /** Eyebrow label shown to the left of the chips. */
  label: string;
  options: ReadonlyArray<FilterOption<V>>;
  value: V | "all";
  onChange: (v: V | "all") => void;
  className?: string;
}

export function FilterChips<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: FilterChipsProps<V>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <FilterChip
            key={opt.value}
            active={value === opt.value}
            tone={opt.tone ?? "neutral"}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.count != null && (
              <span
                className={cn(
                  "ml-1.5 rounded-full px-1.5 py-px text-[10px] tabular-nums",
                  value === opt.value ? "bg-background/40" : "bg-muted text-muted-foreground",
                )}
              >
                {opt.count}
              </span>
            )}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Active-chip tinting matches the same semantic colours we already use
  // for badges — so a Promoter filter pill reads as "green" without needing
  // a tooltip.
  const activeTone =
    tone === "success"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
      : tone === "warning"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
        : tone === "danger"
          ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40"
          : tone === "info"
            ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40"
            : "bg-primary/15 text-foreground border-primary/40";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        active
          ? activeTone
          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
