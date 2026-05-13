"use client";

import { create } from "zustand";
import type {
  ApiLogKind,
  ApiLogStatus,
  ApiLogSummary,
} from "@/lib/server/api-log-buffer";

// Client-side log buffer for browser → Plumage API route calls.
//
// Mirrors the server's `ApiLogSummary` shape so the API Logs page can merge
// server-side and client-side rows into a single chronological list.
//
// Capped at CLIENT_CAP=500 (rolling FIFO). Never persisted — clears on tab
// close / refresh, same as setup keys. The expectation is that for any
// non-trivial debugging, the SE relies on the server log (which captures
// the upstream calls), while the client log fills in "did my browser
// actually hit the route?".

const CLIENT_CAP = 500;

// Re-export so the merged-view page can reuse the same status type.
export type { ApiLogKind, ApiLogStatus, ApiLogSummary };

interface ApiLogsStore {
  entries: ApiLogSummary[];
  append: (entry: ApiLogSummary) => void;
  update: (id: string, patch: Partial<ApiLogSummary>) => void;
  clear: () => void;
}

export const useApiLogsStore = create<ApiLogsStore>((set) => ({
  entries: [],
  append: (entry) =>
    set((s) => {
      const next = [...s.entries, entry];
      while (next.length > CLIENT_CAP) next.shift();
      return { entries: next };
    }),
  update: (id, patch) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  clear: () => set({ entries: [] }),
}));

/**
 * Tiny cheap UUID — fine for non-cryptographic correlation IDs.
 */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Logging wrapper around `fetch`. Records summary entries to the client
 * store before the request is sent and after it completes.
 *
 * - Doesn't capture request/response bodies on the client side — server-side
 *   logging is the system of record for that. Client logs are for "did the
 *   browser successfully reach the server?" debugging.
 * - Preserves the abort signal, headers, body, and return shape of `fetch`,
 *   so callers can swap `fetch(...)` for `loggedFetch(...)` with no other
 *   changes.
 */
export async function loggedFetch(
  url: string,
  init: RequestInit = {},
  meta?: { kind?: ApiLogKind; provider?: string; contextLabel?: string },
): Promise<Response> {
  const id = uuid();
  const startedAt = Date.now();
  const method = (init.method ?? "GET").toUpperCase();
  const endpoint = typeof url === "string" ? url : String(url);

  const summary: ApiLogSummary = {
    id,
    startedAt,
    kind: meta?.kind ?? "internal",
    provider: meta?.provider ?? "plumage",
    method,
    endpoint,
    status: "in_progress",
    hasFullPayload: false,
    contextLabel: meta?.contextLabel,
  };
  useApiLogsStore.getState().append(summary);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const finishedAt = Date.now();
    const isAbort =
      (err instanceof Error && err.name === "AbortError") ||
      init.signal?.aborted === true;
    useApiLogsStore.getState().update(id, {
      finishedAt,
      durationMs: finishedAt - startedAt,
      status: isAbort ? "aborted" : "network_error",
      error: err instanceof Error ? err.message : "Network error",
      httpStatus: 0,
    });
    throw err;
  }

  const finishedAt = Date.now();
  const httpStatus = res.status;
  const bucket: ApiLogStatus =
    httpStatus === 429
      ? "rate_limited"
      : httpStatus >= 200 && httpStatus < 300
        ? "success"
        : httpStatus >= 400 && httpStatus < 500
          ? "client_error"
          : httpStatus >= 500
            ? "server_error"
            : "success";
  useApiLogsStore.getState().update(id, {
    finishedAt,
    durationMs: finishedAt - startedAt,
    status: bucket,
    httpStatus,
  });
  return res;
}
