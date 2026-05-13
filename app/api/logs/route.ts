// API Logs view — list + clear.
//
// GET  /api/logs?since=<ms>&status=<bucket>&kind=<llm|surveysparrow|internal>
//                &provider=<name>&q=<text>&limit=<n>
//      Returns: { entries: ApiLogSummary[], stats: { ... } }
//
// DELETE /api/logs
//      Empties both ring buffers. Returns: { ok: true }.
//
// Both gated by the same auth middleware that wraps every /api/* route.
// No payload data is returned here — that's a separate per-id endpoint so
// the list view stays cheap.

import { NextResponse, type NextRequest } from "next/server";
import {
  clearLogs,
  listLogs,
  stats,
  type ApiLogKind,
  type ApiLogStatus,
} from "@/lib/server/api-log-buffer";

export const runtime = "nodejs";

const KNOWN_STATUSES: ReadonlyArray<ApiLogStatus | "all"> = [
  "all",
  "success",
  "client_error",
  "server_error",
  "rate_limited",
  "network_error",
  "aborted",
  "in_progress",
];

const KNOWN_KINDS: ReadonlyArray<ApiLogKind> = ["llm", "surveysparrow", "internal"];

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const sinceRaw = params.get("since");
  const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined;

  const statusRaw = params.get("status");
  const status =
    statusRaw && (KNOWN_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ApiLogStatus | "all")
      : undefined;

  const kindRaw = params.get("kind");
  const kind =
    kindRaw && (KNOWN_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as ApiLogKind)
      : undefined;

  const provider = params.get("provider") ?? undefined;
  const query = params.get("q") ?? undefined;
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const entries = listLogs({
    since: Number.isFinite(since) ? since : undefined,
    status,
    kind,
    provider: provider || undefined,
    query: query || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json(
    { entries, stats: stats() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE() {
  clearLogs();
  return NextResponse.json({ ok: true });
}
