"use client";

import { useEffect, useMemo, useState } from "react";
import { useResponsesStore } from "@/store/responses-store";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Phase 7d — Live observability panel.
//
// Answers at a glance:
//   • Is the system actively working?       → Active workers count
//   • Are we being rate limited?            → Rate limits count + backoff total
//   • Are retries happening?                → Retry count in log
//   • What is the real observed ETA?        → Observed ETA row
//   • What throughput are we getting?       → Responses / min
//   • P50 / P95 call latency               → Latency row
//
// Design principles:
//   - Hidden when debugLog is empty (no noise before generation starts).
//   - Collapsed by default — a small badge shows the most critical live stat.
//   - Metrics are computed with useMemo; the 1s ETA countdown uses a
//     lightweight counter state so only the ETA cell re-renders.
//   - Event log is capped at 200 entries (store does this); we show the
//     last 80 with a colour-coded gutter.
// ---------------------------------------------------------------------------

const LOG_DISPLAY = 80; // entries shown in the scrollable section

export function DebugPanel() {
  const debugLog = useResponsesStore((s) => s.debugLog);
  const clearDebugLog = useResponsesStore((s) => s.clearDebugLog);
  const progress = useResponsesStore((s) => s.progress);
  const status = useResponsesStore((s) => s.status);

  const [open, setOpen] = useState(false);
  // Tick every second so ETA and throughput stay current between events.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [status]);

  // ---- Derive metrics from the debug log ----------------------------------
  const metrics = useMemo(() => {
    const runStart = progress.startedAt ?? 0;
    // Only entries from the current run segment.
    const inRun = runStart > 0
      ? debugLog.filter((e) => e.time >= runStart)
      : debugLog;

    const workerStarts = inRun.filter((e) => e.kind === "worker_start").length;
    const workerEnds = inRun.filter(
      (e) => e.kind === "worker_done" || e.kind === "worker_fail",
    ).length;
    const activeWorkers = Math.max(0, workerStarts - workerEnds);

    const rlEntries = inRun.filter((e) => e.kind === "rate_limit");
    const rlCount = rlEntries.length;
    const rlTotalMs = rlEntries.reduce((sum, e) => sum + (e.backoffMs ?? 0), 0);

    const retryCount = inRun.filter((e) => e.kind === "retry").length;

    const doneWithLatency = inRun
      .filter((e) => e.kind === "worker_done" && e.latencyMs != null)
      .map((e) => e.latencyMs!);
    const avgLatencyMs =
      doneWithLatency.length > 0
        ? doneWithLatency.reduce((a, b) => a + b, 0) / doneWithLatency.length
        : null;

    // P50 / P95
    const sorted = [...doneWithLatency].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.5)] ?? null) : null;
    const p95 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.95)] ?? null) : null;

    return { activeWorkers, rlCount, rlTotalMs, retryCount, avgLatencyMs, p50, p95 };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugLog, progress.startedAt]);

  // ---- Time-based metrics (need the tick to stay current) -----------------
  const runStart = progress.startedAt ?? 0;
  const now = Date.now();
  const elapsedMs = runStart > 0 ? now - runStart : 0;
  const elapsedMin = elapsedMs / 60_000;

  // Observed throughput: responses completed / elapsed time.
  const throughput =
    elapsedMin > 0.1 && progress.completed > 0
      ? progress.completed / elapsedMin
      : null; // null until we have enough data

  // Observed ETA: remaining / throughput.
  const remaining = Math.max(0, progress.total - progress.completed);
  const etaSec =
    throughput && throughput > 0 ? (remaining / throughput) * 60 : null;

  // Suppress the panel entirely when empty.
  if (debugLog.length === 0) return null;

  // ---- Summary badge (always visible when panel exists) -------------------
  const badgeParts: string[] = [];
  if (status === "running") {
    if (metrics.activeWorkers > 0)
      badgeParts.push(`${metrics.activeWorkers} active`);
    if (throughput !== null)
      badgeParts.push(`${throughput.toFixed(1)}/min`);
    if (metrics.rlCount > 0)
      badgeParts.push(`${metrics.rlCount} RL`);
  } else {
    badgeParts.push(`${debugLog.length} events`);
    if (metrics.rlCount > 0) badgeParts.push(`${metrics.rlCount} rate limits`);
  }

  return (
    <div className="rounded-md border border-border/60 text-xs" data-testid="debug-panel">
      {/* ---- Toggle header ---- */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Activity className="h-3 w-3 shrink-0" aria-hidden />
        <span className="font-medium">Observability</span>
        {badgeParts.length > 0 && (
          <span
            className={cn(
              "ml-1 rounded px-1 py-0.5 text-[10px] font-mono tabular-nums",
              metrics.rlCount > 0
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {badgeParts.join(" · ")}
          </span>
        )}
        <span className="ml-auto text-[10px] opacity-50">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="border-t border-border/60 space-y-0">
          {/* ---- Live metrics grid ---- */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 px-3 py-2 bg-muted/20">
            <Metric
              icon={<Zap className="h-3 w-3" />}
              label="Active workers"
              value={
                status === "running"
                  ? String(metrics.activeWorkers)
                  : "—"
              }
              highlight={status === "running" && metrics.activeWorkers > 0}
            />
            <Metric
              icon={<Activity className="h-3 w-3" />}
              label="Throughput"
              value={throughput !== null ? `${throughput.toFixed(1)}/min` : "—"}
            />
            <Metric
              icon={<Timer className="h-3 w-3" />}
              label="Observed ETA"
              value={
                etaSec !== null
                  ? formatSeconds(etaSec)
                  : progress.completed > 0
                    ? "calculating…"
                    : "—"
              }
            />
            <Metric
              icon={<AlertTriangle className="h-3 w-3" />}
              label="Rate limits"
              value={`${metrics.rlCount} hit${metrics.rlCount !== 1 ? "s" : ""}`}
              warn={metrics.rlCount > 0}
            />
            <Metric
              icon={<Clock className="h-3 w-3" />}
              label="Backoff total"
              value={metrics.rlTotalMs > 0 ? formatMs(metrics.rlTotalMs) : "0s"}
              warn={metrics.rlTotalMs > 30_000}
            />
            <Metric
              icon={<RefreshCw className="h-3 w-3" />}
              label="Retries"
              value={`${metrics.retryCount}`}
              warn={metrics.retryCount > 5}
            />
            {metrics.avgLatencyMs !== null && (
              <Metric
                icon={<Activity className="h-3 w-3" />}
                label="Avg call latency"
                value={formatMs(metrics.avgLatencyMs)}
              />
            )}
            {metrics.p50 !== null && (
              <Metric
                icon={<Activity className="h-3 w-3" />}
                label="P50 / P95"
                value={`${formatMs(metrics.p50)} / ${metrics.p95 != null ? formatMs(metrics.p95) : "—"}`}
              />
            )}
            {progress.completed > 0 && progress.total > 0 && (
              <Metric
                icon={<Activity className="h-3 w-3" />}
                label="Progress"
                value={`${progress.completed} / ${progress.total} (${Math.round((progress.completed / progress.total) * 100)}%)`}
              />
            )}
          </div>

          {/* ---- Event log ---- */}
          <div className="border-t border-border/60">
            <div className="max-h-56 overflow-y-auto font-mono">
              {[...debugLog].reverse().slice(0, LOG_DISPLAY).map((entry, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-2 px-3 py-0.5 hover:bg-muted/20",
                    entry.kind === "worker_fail" || entry.kind === "rate_limit" || entry.kind === "batch_fail"
                      ? "text-amber-600 dark:text-amber-400"
                      : entry.kind === "retry"
                        ? "text-orange-500 dark:text-orange-400"
                        : entry.kind === "worker_done" || entry.kind === "batch_ok"
                          ? "text-green-600 dark:text-green-400"
                          : entry.kind === "info"
                            ? "text-blue-500 dark:text-blue-400"
                            : "text-muted-foreground",
                  )}
                >
                  {/* Timestamp — fixed width so glyph + label columns stay aligned */}
                  <span className="w-16 shrink-0 text-right tabular-nums opacity-50">
                    {new Date(entry.time).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  {/* Kind glyph */}
                  <span className="shrink-0 w-3 text-center opacity-70">
                    {kindGlyph(entry.kind)}
                  </span>
                  {/* Label */}
                  <span className="flex-1 truncate">
                    {entry.label}
                    {entry.latencyMs != null && (
                      <span className="ml-1.5 opacity-60">
                        {formatMs(entry.latencyMs)}
                      </span>
                    )}
                    {entry.backoffMs != null && (
                      <span className="ml-1.5 opacity-60">
                        sleep {formatMs(entry.backoffMs)}
                      </span>
                    )}
                    {entry.detail && (
                      <span className="ml-1 opacity-50">{entry.detail}</span>
                    )}
                  </span>
                </div>
              ))}
              {debugLog.length > LOG_DISPLAY && (
                <div className="px-3 py-0.5 text-muted-foreground opacity-50">
                  +{debugLog.length - LOG_DISPLAY} earlier events
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5">
              <span className="text-[10px] text-muted-foreground opacity-60">
                {debugLog.length} event{debugLog.length !== 1 ? "s" : ""}
                {elapsedMs > 0 && ` · ${formatMs(elapsedMs)} elapsed`}
              </span>
              <button
                type="button"
                onClick={clearDebugLog}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Trash2 className="h-2.5 w-2.5" />
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational atoms
// ---------------------------------------------------------------------------

function Metric({
  icon,
  label,
  value,
  highlight = false,
  warn = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground opacity-70">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          "font-mono tabular-nums font-semibold",
          highlight
            ? "text-primary"
            : warn
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case "worker_start": return "▶";
    case "worker_done":  return "✓";
    case "worker_fail":  return "✗";
    case "rate_limit":   return "⏳";
    case "retry":        return "↺";
    case "info":         return "·";
    case "batch_start":  return "▷";
    case "batch_ok":     return "✓";
    case "batch_fail":   return "✗";
    default:             return "·";
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${Math.ceil(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}
