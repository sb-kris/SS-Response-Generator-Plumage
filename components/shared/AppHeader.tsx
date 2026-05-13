"use client";

import { ConnectionStatusBar } from "./ConnectionStatusBar";
import { LogoutButton } from "./LogoutButton";
import { PlumageWordmark } from "./Wordmark";
import { ThemeSelector } from "./ThemeSelector";
import { ThemeToggle } from "./ThemeToggle";
import { NavLinks } from "./NavLinks";

export function AppHeader() {
  return (
    <header
      className={
        // Glass treatment — softer border, stronger blur, lower opacity
        // when backdrop-filter is supported so the page content underneath
        // visibly fogs through. Falls back to a solid-ish background on
        // browsers that don't support backdrop-filter.
        "sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/50"
      }
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
        {/* Left cluster: wordmark + nav. Replaced the vertical separator with
            whitespace — the separator felt heavy and the gap reads as a
            visual divider on its own. */}
        <div className="flex items-center gap-6">
          <PlumageWordmark />
          <NavLinks />
        </div>
        {/* Right cluster: connection pills, then a thin border-l divider
            separating status info from session utilities (theme + sign out). */}
        <div className="flex items-center gap-2">
          <ConnectionStatusBar />
          <div className="ml-1 flex items-center gap-1 border-l pl-3">
            <ThemeSelector />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </div>
    </header>
  );
}
