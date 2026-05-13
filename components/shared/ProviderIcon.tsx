"use client";

import { cn } from "@/lib/utils";
import type { LLMProvider } from "@/lib/llm/models";

interface Props {
  provider: LLMProvider;
  className?: string;
}

// Inline provider logo, tinted by `currentColor`.
//
// Why mask-image instead of <img>: external SVG files loaded via <img> are
// rasterized at parse time and can't pick up parent `color`. By using the
// SVG as a CSS mask over a `background: currentColor` span, the silhouette
// adapts to text colour — and therefore to whichever theme is active.
//
// Files live under public/brand/llms/{provider}.svg. They're stored as
// solid black silhouettes — the mask uses alpha only, so the file's fill
// colour is irrelevant. Swap any file with the official brand SVG (kept
// in the same path/filename) and it will just work, as long as the new
// file is also a monochrome silhouette.
export function ProviderIcon({ provider, className }: Props) {
  const url = `/brand/llms/${provider}.svg`;
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
