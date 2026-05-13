// Curated colour themes for Plumage.
//
// Each theme = a named set of CSS variable overrides applied as a class on
// <html> alongside next-themes' `.dark`. The Default theme is the baseline
// `:root` / `.dark` in globals.css — no class is added for it.
//
// To add a fifth theme: extend ThemeName, add an entry to THEMES, and add
// the corresponding CSS blocks to globals.css.

export type ThemeName = "default" | "graphite" | "cobalt" | "crimson";

/** localStorage key for persisting the user's colour-theme choice. */
export const THEME_STORAGE_KEY = "plumage-color-theme";

export interface ThemeEntry {
  id: ThemeName;
  label: string;
  description: string;
  /** Hex colour shown as a swatch circle in the picker dropdown. */
  accentSwatch: string;
}

export const THEMES: ThemeEntry[] = [
  {
    id: "default",
    label: "Default",
    description: "Indigo accents, balanced",
    accentSwatch: "#6366f1",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Monochrome devtool",
    accentSwatch: "#a1a1aa",
  },
  {
    id: "cobalt",
    label: "Cobalt",
    description: "Saturated blue",
    accentSwatch: "#2563eb",
  },
  {
    id: "crimson",
    label: "Crimson",
    description: "Deep wine accents",
    // #8B1C2E ≈ hsl(350, 66%, 33%) — the light-mode primary
    accentSwatch: "#8b1c2e",
  },
];
