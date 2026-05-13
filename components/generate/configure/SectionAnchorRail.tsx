"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Lock } from "lucide-react";

export interface AnchorDef {
  /** DOM element id to scroll to + observe. */
  id: string;
  label: string;
  /** Future phase number — when set, the anchor renders disabled with a Lock. */
  futurePhase?: number;
}

interface Props {
  anchors: AnchorDef[];
  /** Hash to scroll into view on mount (e.g. when navigating from /profiles). */
  initialAnchor?: string;
}

/**
 * Left rail of section anchors. Highlights the active section as the user
 * scrolls, and clicking a section smooth-scrolls the viewport to it.
 *
 * Future-phase anchors (Themes, Personas, Language, etc) render as locked
 * placeholders so users can see what's coming without being able to navigate.
 */
export function SectionAnchorRail({ anchors, initialAnchor }: Props) {
  const [activeId, setActiveId] = useState<string | null>(
    initialAnchor ?? anchors.find((a) => !a.futurePhase)?.id ?? null,
  );

  // Observe section visibility — the most-visible section becomes "active".
  useEffect(() => {
    const targets = anchors
      .map((a) => document.getElementById(a.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length > 0) {
          setActiveId(visible[0]!.target.id);
        }
      },
      {
        rootMargin: "-30% 0px -50% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [anchors]);

  // If the page is loaded with a hash, scroll to it on mount.
  useEffect(() => {
    if (initialAnchor) {
      const el = document.getElementById(initialAnchor);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [initialAnchor]);

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
    // Reflect in URL hash so deep links work.
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${id}`);
    }
  }

  return (
    <nav
      aria-label="Configuration sections"
      className="sticky top-20 flex flex-col gap-0.5 text-sm"
    >
      <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Sections
      </div>
      {anchors.map((a) => {
        const locked = Boolean(a.futurePhase);
        const isActive = activeId === a.id;
        const item = (
          <button
            key={a.id}
            type="button"
            disabled={locked}
            onClick={() => !locked && jumpTo(a.id)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left transition-colors",
              isActive && !locked && "bg-accent text-accent-foreground",
              !isActive && !locked && "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              locked && "cursor-not-allowed text-muted-foreground/60",
            )}
          >
            <span className="truncate">{a.label}</span>
            {locked && <Lock className="h-3 w-3 shrink-0" />}
          </button>
        );

        if (locked) {
          return (
            <Tooltip key={a.id}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent side="right">
                Coming soon.
              </TooltipContent>
            </Tooltip>
          );
        }
        return item;
      })}
    </nav>
  );
}

function phaseLetter(n: number): string {
  // We use sub-phase letters (3a, 3b, ...) for Phase 3 sections. The map
  // mirrors the build-spec ordering so future-phase tooltips read naturally.
  const map: Record<number, string> = {
    2: "b",
    3: "c",
    4: "d",
    5: "e",
    6: "f",
    7: "g",
  };
  return map[n] ?? String(n);
}
