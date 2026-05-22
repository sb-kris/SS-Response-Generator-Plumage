"use client";

import { useMemo, useState } from "react";
import type { Persona } from "@/lib/generation/persona-types";
import { LANGUAGES_BY_CODE } from "@/lib/utils/language-geography";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useColumnSort,
  useSingleFilter,
  type SortColumn,
} from "../shared/useTableControls";
import { FilterChips, SortHeader } from "../shared/TableControls";

const INITIAL_VISIBLE = 20;

// Sortable columns + accessors. Keys are typed as a union so the sort
// state can't drift from real column ids.
type ColKey =
  | "index"
  | "name"
  | "language"
  | "country"
  | "sentiment"
  | "verbosity";

const COLUMNS: ReadonlyArray<SortColumn<Persona, ColKey>> = [
  { key: "index",    accessor: (p) => p.index },
  { key: "name",     accessor: (p) => p.name },
  { key: "language", accessor: (p) => p.language },
  { key: "country",  accessor: (p) => p.countryName },
  // Promoter > Passive > Detractor — alphabetical happens to invert the
  // intuitive order, so we map sentiment to a stable rank.
  { key: "sentiment", accessor: (p) =>
      p.sentimentArchetype === "promoter" ? 0 :
      p.sentimentArchetype === "passive"  ? 1 : 2 },
  { key: "verbosity", accessor: (p) =>
      p.verbosity === "terse" ? 0 : p.verbosity === "medium" ? 1 : 2 },
];

interface Props {
  personas: Persona[];
}

export function PersonaTable({ personas }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Sort state — defaults to ascending by index (preserves natural order).
  const { sort, toggleSort, sortRows } = useColumnSort<Persona, ColKey>(COLUMNS);

  // Filters — sentiment + verbosity. Languages are typically too many
  // to chip-row, and sortable-column already covers the "group by lang"
  // need; if a sweep gets long enough to warrant a language dropdown,
  // we'll add one later.
  const sentimentFilter = useSingleFilter<"promoter" | "passive" | "detractor">();
  const verbosityFilter = useSingleFilter<"terse" | "medium" | "verbose">();

  const sentimentCounts = useMemo(() => {
    let promoter = 0, passive = 0, detractor = 0;
    for (const p of personas) {
      if (p.sentimentArchetype === "promoter") promoter++;
      else if (p.sentimentArchetype === "passive") passive++;
      else detractor++;
    }
    return { promoter, passive, detractor };
  }, [personas]);

  // Apply filters first, then sort. Both are O(N); cheap on a 500-row
  // array. Memoised on the personas reference + the filter/sort state.
  const filteredSorted = useMemo(() => {
    const filtered = personas.filter(
      (p) =>
        sentimentFilter.match(p.sentimentArchetype) &&
        verbosityFilter.match(p.verbosity),
    );
    return sortRows(filtered);
  }, [personas, sentimentFilter, verbosityFilter, sortRows]);

  const visible = showAll ? filteredSorted : filteredSorted.slice(0, INITIAL_VISIBLE);
  const total = personas.length;
  const filteredCount = filteredSorted.length;

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-medium">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          View all personas
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {filteredCount !== total
            ? `${filteredCount.toLocaleString()} of ${total.toLocaleString()}`
            : `${total.toLocaleString()} total`}
        </span>
      </button>

      {open && (
        <div className="border-t">
          {/* Filter chip rows — only rendered when meaningful (>1 distinct
              value). Keeps the surface clean for tiny runs. */}
          {personas.length > 1 && (
            <div className="space-y-2 border-b bg-muted/20 px-4 py-3">
              <FilterChips
                label="Sentiment"
                value={sentimentFilter.value}
                onChange={sentimentFilter.setValue}
                options={[
                  { value: "all",       label: "All",       count: total },
                  { value: "promoter",  label: "Promoter",  count: sentimentCounts.promoter, tone: "success" },
                  { value: "passive",   label: "Passive",   count: sentimentCounts.passive,  tone: "neutral" },
                  { value: "detractor", label: "Detractor", count: sentimentCounts.detractor, tone: "danger" },
                ]}
              />
              <FilterChips
                label="Verbosity"
                value={verbosityFilter.value}
                onChange={verbosityFilter.setValue}
                options={[
                  { value: "all",     label: "All" },
                  { value: "terse",   label: "Terse" },
                  { value: "medium",  label: "Medium" },
                  { value: "verbose", label: "Verbose" },
                ]}
              />
            </div>
          )}

          {/* Horizontally scrollable on narrow screens */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <SortHeader columnKey="index"     sort={sort} toggle={toggleSort}>#</SortHeader>
                  <SortHeader columnKey="name"      sort={sort} toggle={toggleSort}>Persona</SortHeader>
                  <SortHeader columnKey="language"  sort={sort} toggle={toggleSort}>Language</SortHeader>
                  <SortHeader columnKey="country"   sort={sort} toggle={toggleSort}>Country</SortHeader>
                  <SortHeader columnKey="sentiment" sort={sort} toggle={toggleSort}>Sentiment</SortHeader>
                  {/* Top concern is free text — not meaningfully sortable. */}
                  <SortHeader columnKey="name" sort={sort} toggle={toggleSort} disabled>Top concern</SortHeader>
                  <SortHeader columnKey="verbosity" sort={sort} toggle={toggleSort}>Verbosity</SortHeader>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No personas match the current filters.
                    </td>
                  </tr>
                ) : (
                  visible.map((p) => <PersonaRow key={p.id} persona={p} />)
                )}
              </tbody>
            </table>
          </div>

          {!showAll && filteredCount > INITIAL_VISIBLE && (
            <div className="flex justify-center border-t bg-muted/20 p-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
                className="gap-1.5 text-xs"
              >
                Show all {filteredCount.toLocaleString()}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------

function PersonaRow({ persona }: { persona: Persona }) {
  const lang = LANGUAGES_BY_CODE[persona.language];
  const langLabel = lang ? `${lang.flag} ${lang.name}` : persona.language.toUpperCase();
  const topConcern = persona.keyConcerns[0] ?? "—";

  return (
    <tr className="border-t">
      <td className="px-3 py-2 align-middle text-xs text-muted-foreground tabular-nums">
        {persona.index}
      </td>
      <td className="px-3 py-2 align-middle">
        <div className="flex items-center gap-2.5">
          {/* DiceBear avatars are SVG; using plain <img> so we don't have to
              configure next/image to allow external SVGs. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(persona.id)}`}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full bg-muted"
            loading="lazy"
          />
          <div className="min-w-0">
            <div className="truncate font-medium">{persona.name}</div>
            <div className="truncate text-xs text-muted-foreground">{persona.email}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 align-middle text-xs">{langLabel}</td>
      <td className="px-3 py-2 align-middle text-xs">
        <div className="truncate">{persona.countryName}</div>
        <div className="truncate text-[10px] text-muted-foreground">{persona.city}</div>
      </td>
      <td className="px-3 py-2 align-middle">
        <SentimentBadge sentiment={persona.sentimentArchetype} />
      </td>
      <td className="px-3 py-2 align-middle text-xs">
        <span className="line-clamp-1">{topConcern}</span>
      </td>
      <td className="px-3 py-2 align-middle">
        <VerbosityPill verbosity={persona.verbosity} />
      </td>
    </tr>
  );
}

function SentimentBadge({ sentiment }: { sentiment: Persona["sentimentArchetype"] }) {
  const variant =
    sentiment === "promoter" ? "success" : sentiment === "detractor" ? "destructive" : "secondary";
  const label =
    sentiment === "promoter" ? "Promoter" : sentiment === "detractor" ? "Detractor" : "Passive";
  return (
    <Badge variant={variant} className="text-[10px]">
      {label}
    </Badge>
  );
}

function VerbosityPill({ verbosity }: { verbosity: Persona["verbosity"] }) {
  const cls =
    verbosity === "verbose"
      ? "bg-primary/10 text-primary"
      : verbosity === "terse"
        ? "bg-muted text-muted-foreground"
        : "bg-secondary text-secondary-foreground";
  return (
    <span className={cn("rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", cls)}>
      {verbosity}
    </span>
  );
}
