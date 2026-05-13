"use client";

import { useState } from "react";
import type { Persona } from "@/lib/generation/persona-types";
import { LANGUAGES_BY_CODE } from "@/lib/utils/language-geography";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const INITIAL_VISIBLE = 20;

interface Props {
  personas: Persona[];
}

export function PersonaTable({ personas }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? personas : personas.slice(0, INITIAL_VISIBLE);

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
        <span className="text-xs text-muted-foreground">
          {personas.length.toLocaleString()} total
        </span>
      </button>

      {open && (
        <div className="border-t">
          {/* Horizontally scrollable on narrow screens */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Persona</th>
                  <th className="px-3 py-2 text-left font-medium">Language</th>
                  <th className="px-3 py-2 text-left font-medium">Country</th>
                  <th className="px-3 py-2 text-left font-medium">Sentiment</th>
                  <th className="px-3 py-2 text-left font-medium">Top concern</th>
                  <th className="px-3 py-2 text-left font-medium">Verbosity</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <PersonaRow key={p.id} persona={p} />
                ))}
              </tbody>
            </table>
          </div>

          {!showAll && personas.length > INITIAL_VISIBLE && (
            <div className="flex justify-center border-t bg-muted/20 p-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
                className="gap-1.5 text-xs"
              >
                Show all {personas.length.toLocaleString()}
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
