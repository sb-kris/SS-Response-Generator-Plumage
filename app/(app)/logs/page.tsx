"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCcw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Activity,
  AlertCircle,
  Search,
} from "lucide-react";
import {
  useApiLogsStore,
  type ApiLogStatus,
  type ApiLogSummary,
  type ApiLogKind,
} from "@/store/api-logs-store";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Polling configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Merged view types — `source` distinguishes client-recorded vs server-recorded.
// ---------------------------------------------------------------------------

type MergedEntry = ApiLogSummary & { source: "client" | "server" };

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Array<{
  id: "all" | "running" | "success" | "failed" | "rate_limited" | "retried";
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "running", label: "In progress" },
  { id: "success", label: "Success" },
  { id: "failed", label: "Failed" },
  { id: "rate_limited", label: "Rate limited" },
  { id: "retried", label: "Retried" },
];

const KIND_FILTERS: Array<{ id: "all" | ApiLogKind; label: string }> = [
  { id: "all", label: "All sources" },
  { id: "llm", label: "LLM" },
  { id: "surveysparrow", label: "SurveySparrow" },
  { id: "internal", label: "Internal" },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApiLogsPage() {
  const clientEntries = useApiLogsStore((s) => s.entries);
  const clearClientStore = useApiLogsStore((s) => s.clear);

  const [serverEntries, setServerEntries] = useState<ApiLogSummary[]>([]);
  const [serverStats, setServerStats] = useState<{
    summaryCount: number;
    payloadCount: number;
    summaryCap: number;
    payloadCap: number;
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]["id"]>("all");
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ---- Polling -----------------------------------------------------------

  const fetchServerLogs = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch("/api/logs", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        entries: ApiLogSummary[];
        stats: { summaryCount: number; payloadCount: number; summaryCap: number; payloadCap: number };
      };
      setServerEntries(json.entries);
      setServerStats(json.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Initial load + polling while the tab is visible.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!active) return;
      if (document.visibilityState === "visible") {
        await fetchServerLogs();
      }
      if (!active) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    // Refresh immediately when the tab becomes visible.
    const onVis = () => {
      if (document.visibilityState === "visible") fetchServerLogs();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [fetchServerLogs]);

  // ---- Clear ------------------------------------------------------------

  async function handleClear() {
    try {
      await fetch("/api/logs", { method: "DELETE", cache: "no-store" });
    } catch {
      // Ignore — UI will refresh on next poll regardless.
    }
    clearClientStore();
    setServerEntries([]);
    await fetchServerLogs();
  }

  // ---- Merge + filter ---------------------------------------------------

  const merged: MergedEntry[] = useMemo(() => {
    const seen = new Set<string>();
    const out: MergedEntry[] = [];
    // Server entries first so they take precedence over any duplicate id.
    for (const e of serverEntries) {
      seen.add(e.id);
      out.push({ ...e, source: "server" });
    }
    for (const e of clientEntries) {
      if (seen.has(e.id)) continue;
      out.push({ ...e, source: "client" });
    }
    // Newest first.
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }, [serverEntries, clientEntries]);

  const filtered: MergedEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return merged.filter((e) => {
      // Status bucketed filter (the API uses fine-grained ApiLogStatus; we
      // collapse it to user-friendly buckets here).
      if (statusFilter !== "all") {
        const passes = matchesStatusFilter(e, statusFilter);
        if (!passes) return false;
      }
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (q) {
        const hay = `${e.endpoint} ${e.error ?? ""} ${e.contextLabel ?? ""} ${e.provider}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [merged, statusFilter, kindFilter, query]);

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">API logs</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Request-level traceability for every outbound LLM / SurveySparrow call
          and every browser → Plumage API route hit. In-memory ring buffer —
          last {serverStats?.summaryCap ?? 500} summaries kept, last{" "}
          {serverStats?.payloadCap ?? 50} also retain full request/response
          bodies for expansion. Process restart clears everything.
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-4 w-4" />
              Recent calls
              {serverStats && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  {serverStats.summaryCount}/{serverStats.summaryCap} summary ·{" "}
                  {serverStats.payloadCount}/{serverStats.payloadCap} full
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              Refreshes every 2 s while this tab is visible. Click a row to view
              full request + response payloads.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchServerLogs}
              disabled={refreshing}
              className="gap-1.5"
            >
              <RefreshCcw
                className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
              />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClear}
              className="gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Couldn&apos;t fetch server logs: {error}</span>
            </div>
          )}

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((f) => (
                <FilterChip
                  key={f.id}
                  label={f.label}
                  active={statusFilter === f.id}
                  onClick={() => setStatusFilter(f.id)}
                />
              ))}
            </div>
            <div className="h-5 w-px bg-border" />
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((f) => (
                <FilterChip
                  key={f.id}
                  label={f.label}
                  active={kindFilter === f.id}
                  onClick={() => setKindFilter(f.id)}
                />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search endpoint, error, label…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-7 w-56 text-xs"
              />
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div className="rounded-md border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
              {merged.length === 0
                ? "No API calls captured yet. Run a generation or test a connection to populate this view."
                : "No entries match the current filters."}
            </div>
          ) : (
            <LogsTable entries={filtered} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status filter matcher
// ---------------------------------------------------------------------------

function matchesStatusFilter(
  e: MergedEntry,
  f: (typeof STATUS_FILTERS)[number]["id"],
): boolean {
  switch (f) {
    case "all":
      return true;
    case "running":
      return e.status === "in_progress";
    case "success":
      return e.status === "success";
    case "rate_limited":
      return e.status === "rate_limited";
    case "retried":
      return (e.retryCount ?? 0) > 0;
    case "failed":
      return (
        e.status === "client_error" ||
        e.status === "server_error" ||
        e.status === "network_error" ||
        e.status === "rate_limited" ||
        e.status === "aborted"
      );
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// FilterChip — compact toggleable button
// ---------------------------------------------------------------------------

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Logs table
// ---------------------------------------------------------------------------

interface LogsTableProps {
  entries: MergedEntry[];
}

function LogsTable({ entries }: LogsTableProps) {
  // Cap rendered rows. With 500 server + 500 client entries the merged max
  // is 1000; rendering all of them is still fine but slowing only as the
  // dataset grows. Cap is generous; SE filters to drill in.
  const visible = entries.slice(0, 500);

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-6 px-2 py-1.5" aria-label="expand" />
            <th className="px-2 py-1.5 text-left font-medium">Time</th>
            <th className="px-2 py-1.5 text-left font-medium">Source</th>
            <th className="px-2 py-1.5 text-left font-medium">Provider</th>
            <th className="px-2 py-1.5 text-left font-medium">Method</th>
            <th className="px-2 py-1.5 text-left font-medium">Endpoint</th>
            <th className="px-2 py-1.5 text-right font-medium">Status</th>
            <th className="px-2 py-1.5 text-right font-medium">Duration</th>
            <th className="px-2 py-1.5 text-right font-medium">Retries</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry) => (
            <LogRow key={`${entry.source}:${entry.id}`} entry={entry} />
          ))}
        </tbody>
      </table>
      {entries.length > visible.length && (
        <div className="border-t bg-muted/20 px-3 py-1.5 text-center text-[10px] text-muted-foreground">
          Showing first {visible.length} of {entries.length} — refine filters to narrow.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogRow — collapsed summary + lazy-loaded expand
// ---------------------------------------------------------------------------

interface FullPayload {
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
}

function LogRow({ entry }: { entry: MergedEntry }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<FullPayload | null>(null);
  const [payloadStatus, setPayloadStatus] = useState<
    "idle" | "loading" | "loaded" | "expired" | "error" | "unavailable"
  >("idle");
  const fetchedFor = useRef<string | null>(null);

  // Fetch full payload on first expand. Server-side entries only — client
  // entries don't have payload bodies (we don't capture them in the browser).
  useEffect(() => {
    if (!open) return;
    if (entry.source !== "server") {
      setPayloadStatus("unavailable");
      return;
    }
    if (!entry.hasFullPayload) {
      setPayloadStatus("expired");
      return;
    }
    if (fetchedFor.current === entry.id) return;
    fetchedFor.current = entry.id;
    setPayloadStatus("loading");
    fetch(`/api/logs/${encodeURIComponent(entry.id)}`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 404) {
          setPayloadStatus("expired");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { payload: FullPayload };
        setPayload(json.payload);
        setPayloadStatus("loaded");
      })
      .catch(() => setPayloadStatus("error"));
  }, [open, entry.id, entry.hasFullPayload, entry.source]);

  return (
    <>
      <tr
        className={cn(
          "border-t cursor-pointer hover:bg-muted/30",
          open && "bg-muted/30",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-2 py-1.5 align-middle">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </td>
        <td className="px-2 py-1.5 align-middle font-mono text-[11px] text-muted-foreground">
          {formatTime(entry.startedAt)}
        </td>
        <td className="px-2 py-1.5 align-middle">
          <SourceBadge source={entry.source} />
        </td>
        <td className="px-2 py-1.5 align-middle">
          <KindBadge kind={entry.kind} provider={entry.provider} />
        </td>
        <td className="px-2 py-1.5 align-middle font-mono text-[10px]">
          {entry.method}
        </td>
        <td className="max-w-[420px] truncate px-2 py-1.5 align-middle font-mono text-[10px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{summarizeEndpoint(entry.endpoint)}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-md break-all font-mono text-[10px]">
              {entry.endpoint}
              {entry.contextLabel && (
                <div className="mt-1 text-muted-foreground">
                  ctx: {entry.contextLabel}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        </td>
        <td className="px-2 py-1.5 text-right align-middle">
          <StatusBadge entry={entry} />
        </td>
        <td className="px-2 py-1.5 text-right align-middle font-mono tabular-nums">
          {entry.durationMs !== undefined ? `${entry.durationMs}ms` : "—"}
        </td>
        <td className="px-2 py-1.5 text-right align-middle font-mono tabular-nums">
          {entry.retryCount ?? 0}
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/10">
          <td colSpan={9} className="px-3 py-2">
            <ExpandedDetail
              entry={entry}
              payloadStatus={payloadStatus}
              payload={payload}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail — request / response / headers / error
// ---------------------------------------------------------------------------

function ExpandedDetail({
  entry,
  payloadStatus,
  payload,
}: {
  entry: MergedEntry;
  payloadStatus:
    | "idle"
    | "loading"
    | "loaded"
    | "expired"
    | "error"
    | "unavailable";
  payload: FullPayload | null;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      {/* Meta line */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span>
          <strong className="text-foreground">ID:</strong>{" "}
          <span className="font-mono">{entry.id.slice(0, 13)}…</span>
        </span>
        <span>
          <strong className="text-foreground">Started:</strong>{" "}
          {new Date(entry.startedAt).toISOString()}
        </span>
        {entry.finishedAt && (
          <span>
            <strong className="text-foreground">Finished:</strong>{" "}
            {new Date(entry.finishedAt).toISOString()}
          </span>
        )}
        {entry.httpStatus !== undefined && (
          <span>
            <strong className="text-foreground">HTTP:</strong> {entry.httpStatus}
          </span>
        )}
      </div>

      {entry.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
            Error
          </div>
          <pre className="whitespace-pre-wrap break-words text-[11px] text-destructive">
            {entry.error}
          </pre>
        </div>
      )}

      {/* Payload section */}
      {payloadStatus === "unavailable" && (
        <NotePanel tone="muted">
          Browser-side entry — request and response bodies are captured
          server-side. Use the matching server entry (if any) for full payload
          inspection.
        </NotePanel>
      )}
      {payloadStatus === "expired" && (
        <NotePanel tone="muted">
          Payload expired — only summary retained. The server keeps the last
          50 full payloads; older entries lose their bodies.
        </NotePanel>
      )}
      {payloadStatus === "error" && (
        <NotePanel tone="error">
          Failed to fetch full payload. Try refreshing.
        </NotePanel>
      )}
      {payloadStatus === "loading" && (
        <NotePanel tone="muted">Loading full payload…</NotePanel>
      )}
      {payloadStatus === "loaded" && payload && (
        <PayloadSection payload={payload} />
      )}
    </div>
  );
}

function NotePanel({
  tone,
  children,
}: {
  tone: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-2 text-[11px]",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-muted bg-muted/30 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function PayloadSection({ payload }: { payload: FullPayload }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <PayloadBlock
        title="Request body"
        body={payload.requestBody}
        truncated={payload.requestTruncated}
        headers={payload.requestHeaders}
      />
      <PayloadBlock
        title="Response body"
        body={payload.responseBody}
        truncated={payload.responseTruncated}
        headers={payload.responseHeaders}
      />
    </div>
  );
}

function PayloadBlock({
  title,
  body,
  truncated,
  headers,
}: {
  title: string;
  body?: string;
  truncated?: boolean;
  headers?: Record<string, string>;
}) {
  const [showHeaders, setShowHeaders] = useState(false);
  const pretty = useMemo(() => prettyJson(body), [body]);

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b bg-muted/30 px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
          {title}
        </span>
        {headers && Object.keys(headers).length > 0 && (
          <button
            type="button"
            onClick={() => setShowHeaders((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showHeaders ? "Hide headers" : `Headers (${Object.keys(headers).length})`}
          </button>
        )}
      </div>
      {showHeaders && headers && (
        <pre className="max-h-32 overflow-auto border-b bg-muted/20 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
          {Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
        </pre>
      )}
      <pre className="max-h-80 overflow-auto px-2 py-1.5 text-[10px] leading-relaxed">
        {pretty ?? <span className="italic text-muted-foreground">(empty)</span>}
      </pre>
      {truncated && (
        <div className="border-t bg-amber-50/50 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          Truncated at 32 KB.
        </div>
      )}
    </div>
  );
}

function prettyJson(body: string | undefined): string | null {
  if (!body) return null;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: "client" | "server" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        source === "server"
          ? "border-blue-300/60 bg-blue-50 text-blue-700 dark:border-blue-700/40 dark:bg-blue-950/40 dark:text-blue-300"
          : "border-slate-300/60 bg-slate-50 text-slate-700 dark:border-slate-700/40 dark:bg-slate-950/40 dark:text-slate-300",
      )}
    >
      {source === "server" ? "server" : "browser"}
    </span>
  );
}

function KindBadge({ kind, provider }: { kind: ApiLogKind; provider: string }) {
  const tone =
    kind === "llm"
      ? "border-violet-300/60 bg-violet-50 text-violet-700 dark:border-violet-700/40 dark:bg-violet-950/40 dark:text-violet-300"
      : kind === "surveysparrow"
        ? "border-emerald-300/60 bg-emerald-50 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-300"
        : "border-slate-300/60 bg-slate-50 text-slate-700 dark:border-slate-700/40 dark:bg-slate-950/40 dark:text-slate-300";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        tone,
      )}
    >
      {provider}
    </span>
  );
}

function StatusBadge({ entry }: { entry: ApiLogSummary }) {
  const { status, httpStatus } = entry;
  const map: Record<ApiLogStatus, { label: string; tone: string }> = {
    success: {
      label: httpStatus ? String(httpStatus) : "ok",
      tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    },
    client_error: {
      label: httpStatus ? String(httpStatus) : "4xx",
      tone: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    },
    server_error: {
      label: httpStatus ? String(httpStatus) : "5xx",
      tone: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    },
    rate_limited: {
      label: "429",
      tone: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    },
    network_error: {
      label: "net",
      tone: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    },
    aborted: {
      label: "abort",
      tone: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
    },
    in_progress: {
      label: "…",
      tone: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    },
  };
  const meta = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none",
        meta.tone,
      )}
    >
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false }) +
    `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function summarizeEndpoint(url: string): string {
  // Strip query strings and the protocol/host to keep the table readable.
  try {
    if (url.startsWith("http")) {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    }
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  } catch {
    return url;
  }
}
