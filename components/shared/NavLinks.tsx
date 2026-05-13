"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSetupStore } from "@/store/setup-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  // True if this route requires both SS and LLM connections to be healthy.
  requiresConnections?: boolean;
  /** Optional hover tooltip — used when the label alone needs disambiguation
   *  (e.g. "Logs" → "API request logs"). */
  hoverHint?: string;
}

const ITEMS: NavItem[] = [
  { href: "/", label: "Setup" },
  { href: "/generate", label: "Generate", requiresConnections: true },
  { href: "/profiles", label: "Profiles" },
  { href: "/logs", label: "Logs", hoverHint: "API request logs" },
];

export function NavLinks() {
  const pathname = usePathname();
  const ssOk = useSetupStore((s) => s.ssConnection.status === "ok");
  const llmOk = useSetupStore((s) => s.llmConnection.status === "ok");
  const bothConnected = ssOk && llmOk;

  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map((item) => {
        // Exact match for "/", prefix match for nested routes (e.g. /generate/foo).
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const blocked = Boolean(item.requiresConnections) && !bothConnected;

        const linkClass = cn(
          "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          blocked && "cursor-not-allowed opacity-60",
        );

        // Always navigable — gating happens on the destination page so the user
        // sees an explanation rather than nothing happening on click. Tooltip
        // hints at it on hover.
        const link = (
          <Link key={item.href} href={item.href} className={linkClass}>
            {item.label}
          </Link>
        );

        if (blocked) {
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="bottom">
                Connect SurveySparrow + your LLM on the setup screen first.
              </TooltipContent>
            </Tooltip>
          );
        }
        if (item.hoverHint) {
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="bottom">{item.hoverHint}</TooltipContent>
            </Tooltip>
          );
        }
        return link;
      })}
    </nav>
  );
}
