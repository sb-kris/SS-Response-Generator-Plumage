import { cn } from "@/lib/utils";

// Plumage wordmark — the official brand SVG from /brand/plumage-logo.svg.
// Was previously a hand-drawn React SVG; switched to the file asset so a
// single source of truth lives in /public/brand/ for both app + deck.
export function PlumageMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/plumage-logo.svg"
      alt=""
      aria-hidden
      className={cn("h-8 w-8 shrink-0 object-contain", className)}
    />
  );
}

/**
 * Brand wordmark. Always shows "Response Generator" beneath the Plumage
 * name so first-time visitors know what the app is without exploring —
 * this is the front-door label, not a hidden tooltip.
 *
 * `showTagline` adds the longer marketing tagline below — used on the
 * login page where there's vertical room for it.
 */
export function PlumageWordmark({
  showTagline = false,
  className,
}: {
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <PlumageMark className="h-9 w-9" />
      <div className="leading-tight">
        <div className="text-base font-semibold tracking-tight">Plumage</div>
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Response Generator
        </div>
        {showTagline && (
          <div className="mt-0.5 text-xs text-muted-foreground/80">
            Demo data, fully feathered.
          </div>
        )}
      </div>
    </div>
  );
}
