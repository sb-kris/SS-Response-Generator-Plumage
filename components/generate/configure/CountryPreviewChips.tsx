"use client";

import { useState } from "react";
import { getCountryPreview } from "@/lib/utils/language-geography";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const VISIBLE_CHIPS = 3;

interface Props {
  languageCode: string;
}

/**
 * Compact country breakdown shown beneath each language slider.
 * Shows the top {VISIBLE_CHIPS} countries; the rest collapse into a "+N more"
 * toggle that expands a full breakdown table.
 */
export function CountryPreviewChips({ languageCode }: Props) {
  const countries = getCountryPreview(languageCode);
  const [expanded, setExpanded] = useState(false);

  if (countries.length === 0) return null;

  const visible = countries.slice(0, VISIBLE_CHIPS);
  const overflow = countries.length - VISIBLE_CHIPS;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.map((c) => (
          <span
            key={c.code}
            className="inline-flex items-center gap-1 rounded-full border bg-card/50 px-2 py-0.5 text-[11px] tabular-nums"
            title={c.name}
          >
            <span aria-hidden>{c.flag}</span>
            <span className="font-medium">{c.code}</span>
            <span className="text-muted-foreground">{c.weight}%</span>
          </span>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              "text-muted-foreground hover:text-foreground",
            )}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "Show less" : `+${overflow} more`}
          </button>
        )}
      </div>

      {expanded && (
        <div className="rounded-md border bg-muted/20 p-2.5">
          <ul className="grid gap-x-4 gap-y-1 text-[11px] tabular-nums sm:grid-cols-2">
            {countries.map((c) => (
              <li key={c.code} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden>{c.flag}</span>
                  <span className="truncate text-foreground">{c.name}</span>
                </span>
                <span className="font-medium text-muted-foreground">{c.weight}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Geographic distributions are based on speaker populations and are
            illustrative, not statistical. Persona synthesis picks each
            persona&apos;s country from this distribution.
          </p>
        </div>
      )}
    </div>
  );
}
