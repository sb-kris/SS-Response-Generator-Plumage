"use client";

import { useEffect, useState } from "react";
import { Check, MousePointerClick, Palette, Sparkles, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEMES, THEME_STORAGE_KEY, type ThemeName } from "@/lib/theme/themes";
import { startThemeTransition } from "@/lib/theme/transition";
import { usePreferencesStore } from "@/store/preferences-store";

// Apply a colour theme by toggling theme-* classes on <html>.
// Removes all existing theme classes first so there's no bleed-through.
function applyThemeClass(name: ThemeName) {
  const el = document.documentElement;
  for (const t of THEMES) {
    el.classList.remove(`theme-${t.id}`);
  }
  if (name !== "default") {
    el.classList.add(`theme-${name}`);
  }
}

export function ThemeSelector() {
  const [current, setCurrent] = useState<ThemeName>("default");
  const [mounted, setMounted] = useState(false);
  const cursorEffects = usePreferencesStore((s) => s.cursorEffects);
  const setCursorEffects = usePreferencesStore((s) => s.setCursorEffects);
  const soundEnabled = usePreferencesStore((s) => s.soundEnabled);
  const setSoundEnabled = usePreferencesStore((s) => s.setSoundEnabled);
  const clickSoundEnabled = usePreferencesStore((s) => s.clickSoundEnabled);
  const setClickSoundEnabled = usePreferencesStore((s) => s.setClickSoundEnabled);

  // Read persisted preference on mount and re-apply the class in case the
  // inline script in layout.tsx ran before React's class list was populated.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemeName | null;
      if (stored && THEMES.some((t) => t.id === stored)) {
        setCurrent(stored);
        applyThemeClass(stored);
      }
    } catch {
      // localStorage unavailable (private browsing restrictions, etc.) — no-op.
    }
    setMounted(true);
  }, []);

  function handleSelect(name: ThemeName) {
    // Wrap the DOM mutation inside startViewTransition so the wipe captures
    // the before/after CSS-variable states. setCurrent (React state) outside
    // the wrapper is fine — only applyThemeClass mutates the page synchronously
    // and that's what the snapshot diff needs.
    startThemeTransition(() => {
      applyThemeClass(name);
    });
    setCurrent(name);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, name);
    } catch {
      // Persist failure is silent — theme still applies for this session.
    }
  }

  // Render a same-size invisible placeholder until mounted to avoid layout
  // shift and hydration mismatches (mirrors ThemeToggle's pattern).
  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" disabled className="opacity-0" aria-hidden />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="Colour theme">
          <Palette className="h-4 w-4" />
          <span className="sr-only">Colour theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className="gap-2.5 py-2"
          >
            {/* Accent swatch */}
            <div
              className="h-3 w-3 shrink-0 rounded-full border border-black/10"
              style={{ backgroundColor: t.accentSwatch }}
            />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium leading-none">{t.label}</span>
              <span className="mt-0.5 text-xs text-muted-foreground">
                {t.description}
              </span>
            </div>
            {current === t.id && (
              <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
            )}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Effects
        </DropdownMenuLabel>
        {/* Cursor breadcrumbs — opt-in by default. Checkbox item keeps the
            mental model simple: this is a toggle, not a destination. */}
        <DropdownMenuCheckboxItem
          checked={cursorEffects}
          onCheckedChange={setCursorEffects}
          onSelect={(e) => e.preventDefault()}
          className="gap-2.5 py-2"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium leading-none">
              Cursor breadcrumbs
            </span>
            <span className="mt-0.5 text-xs leading-tight text-muted-foreground">
              Persona faces drift behind your cursor while generating.
            </span>
          </div>
        </DropdownMenuCheckboxItem>

        {/* Celebration & connection-status chimes. Covers push success,
            setup connection success/failure. On by default. */}
        <DropdownMenuCheckboxItem
          checked={soundEnabled}
          onCheckedChange={setSoundEnabled}
          onSelect={(e) => e.preventDefault()}
          className="gap-2.5 py-2"
        >
          <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium leading-none">
              Status chimes
            </span>
            <span className="mt-0.5 text-xs leading-tight text-muted-foreground">
              Short cues on push complete and connection success/failure.
            </span>
          </div>
        </DropdownMenuCheckboxItem>

        {/* Button click sounds — separate, defaults OFF. Power-user / niche
            preference; otherwise risks being annoying. */}
        <DropdownMenuCheckboxItem
          checked={clickSoundEnabled}
          onCheckedChange={setClickSoundEnabled}
          onSelect={(e) => e.preventDefault()}
          className="gap-2.5 py-2"
        >
          <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium leading-none">
              Button click sounds
            </span>
            <span className="mt-0.5 text-xs leading-tight text-muted-foreground">
              Soft mechanical click on every button.
            </span>
          </div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
