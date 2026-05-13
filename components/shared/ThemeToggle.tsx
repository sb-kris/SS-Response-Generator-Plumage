"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { startThemeTransition } from "@/lib/theme/transition";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Render a placeholder of the same size to avoid layout shift during hydration.
    return <Button variant="ghost" size="icon" disabled className="opacity-0" aria-hidden />;
  }

  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        // Wrap the next-themes class swap in a View Transition so the wipe
        // captures the before/after states. Falls back to instant change on
        // unsupported browsers or reduced-motion users.
        startThemeTransition(() => setTheme(isDark ? "light" : "dark"));
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
