"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useSetupStore, type ConnectionState } from "@/store/setup-store";
import { getProviderLabel } from "@/lib/llm/models";
import { formatRelativeTime, cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { XCircle, Loader2, Circle, Clock } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";

const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

interface DotProps {
  state: ConnectionState;
  /** Short label rendered in the pill (kept under ~3 chars for compact width). */
  label: string;
  /** Full label used in tooltips. Defaults to `label` if the abbreviation is
   *  already clear. The pill stays compact; the tooltip stays informative. */
  tooltipLabel?: string;
  // Optional free-text identifier shown after the label (e.g. workspace nickname).
  nickname?: string;
  /** Brand symbol shown before the status indicator when status is "ok"
   *  (and the connection isn't stale). Tiny reminder of "plugged into X". */
  brandSymbolSrc?: string;
  /** Alt text for the brand symbol — used by screen readers. */
  brandSymbolAlt?: string;
  /** Pre-rendered brand symbol node — used when the icon needs to inherit
   *  currentColor (e.g. provider monogram icons). Takes precedence over
   *  brandSymbolSrc when both are provided. */
  brandSymbolNode?: React.ReactNode;
}

// Pulsing heartbeat dot for "connected" status — soft outer ring expands and
// fades on a 3s cadence (3s reads as a heartbeat; 1s default would feel
// anxious). Inner dot stays solid green so the state is unambiguous even
// when the pulse is mid-fade.
function PulsingDot() {
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden"
        style={{ animationDuration: "3s" }}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

function StatusDot({
  state,
  label,
  tooltipLabel,
  nickname,
  brandSymbolSrc,
  brandSymbolAlt,
  brandSymbolNode,
}: DotProps) {
  const fullLabel = tooltipLabel ?? label;
  // Tick periodically so relative time stays fresh.
  const [, force] = useState(0);
  useEffect(() => {
    if (state.status !== "ok") return;
    const id = setInterval(() => force((n) => n + 1), 30 * 1000);
    return () => clearInterval(id);
  }, [state.status]);

  const stale =
    state.status === "ok" &&
    state.lastSuccessAt !== null &&
    Date.now() - state.lastSuccessAt > STALE_AFTER_MS;

  let icon: React.ReactNode;
  let color = "";
  let tooltip = "";

  switch (state.status) {
    case "validating":
      icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      color = "text-muted-foreground";
      tooltip = `${fullLabel}: validating...`;
      break;
    case "ok":
      if (stale) {
        icon = <Clock className="h-3.5 w-3.5" />;
        color = "text-warning";
        tooltip = `${fullLabel}: connected ${formatRelativeTime(state.lastSuccessAt)} — consider re-testing.`;
      } else {
        // Pulsing heartbeat dot — feels alive on the page without being noisy.
        icon = <PulsingDot />;
        color = "text-success";
        tooltip = `${fullLabel}: connected (tested ${formatRelativeTime(state.lastSuccessAt)})`;
      }
      break;
    case "error":
      icon = <XCircle className="h-3.5 w-3.5" />;
      color = "text-destructive";
      tooltip = `${fullLabel}: ${state.error ?? "connection failed"}`;
      break;
    default:
      icon = <Circle className="h-3.5 w-3.5" />;
      color = "text-muted-foreground/60";
      tooltip = `${fullLabel}: not yet tested`;
  }

  // Compact summary — pill width matters more than verbosity here. Full
  // context lives in the tooltip if the user wants it.
  const summary =
    state.status === "ok"
      ? formatRelativeTime(state.lastSuccessAt)
      : state.status === "validating"
        ? "…"
        : state.status === "error"
          ? "failed"
          : "—";

  // Show nickname only once the connection is healthy — pre-test it's noise.
  const showNickname = nickname && nickname.trim().length > 0 && state.status === "ok";
  // Brand symbol appears only when connected + fresh — signals "you're
  // actively plugged into THEIR system" without screaming about it.
  const showBrandSymbol = (brandSymbolNode || brandSymbolSrc) && state.status === "ok" && !stale;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border bg-card/50 px-2 py-1 text-xs",
            color,
          )}
        >
          {showBrandSymbol && (
            brandSymbolNode ? (
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center opacity-90">
                {brandSymbolNode}
              </span>
            ) : (
              <Image
                src={brandSymbolSrc!}
                alt={brandSymbolAlt ?? ""}
                width={14}
                height={14}
                className="h-3.5 w-3.5 opacity-90"
                aria-hidden={brandSymbolAlt ? undefined : true}
              />
            )
          )}
          {icon}
          <span className="font-medium text-foreground">{label}</span>
          {showNickname && (
            <>
              <span className="text-muted-foreground">·</span>
              <span
                className="max-w-[120px] truncate font-medium text-foreground"
                title={nickname}
              >
                {nickname}
              </span>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{summary}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {tooltip}
        {showNickname && <span className="block opacity-80">Workspace: {nickname}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function ConnectionStatusBar() {
  const ssConnection = useSetupStore((s) => s.ssConnection);
  const ssNickname = useSetupStore((s) => s.surveySparrow.workspaceNickname);
  const llmConnection = useSetupStore((s) => s.llmConnection);
  const provider = useSetupStore((s) => s.llm.provider);
  const llmLabel = getProviderLabel(provider);

  return (
    <div className="flex items-center gap-2">
      {/* Pill labels are abbreviated to keep header width predictable —
          tooltips still spell out "SurveySparrow" for clarity. */}
      <StatusDot
        state={ssConnection}
        label="SS"
        tooltipLabel="SurveySparrow"
        nickname={ssNickname}
        brandSymbolSrc="/brand/surveysparrow-symbol.svg"
        brandSymbolAlt="SurveySparrow"
      />
      <StatusDot
        state={llmConnection}
        label={llmLabel}
        brandSymbolNode={<ProviderIcon provider={provider} className="h-3 w-3" />}
      />
    </div>
  );
}
