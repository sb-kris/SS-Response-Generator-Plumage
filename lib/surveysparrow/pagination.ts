import { surveySparrowFetch, type SurveySparrowClientConfig } from "./client";
import type { PaginatedResponse } from "./types";

interface FetchAllPagesOptions {
  // Hard cap so a runaway query can't pull thousands of pages.
  maxPages?: number;
  // Per-page limit (SS max is 100; default 100 to minimize round-trips).
  perPage?: number;
}

interface FetchAllPagesResult<T> {
  ok: boolean;
  status: number;
  data: T[];
  error?: string;
  truncated?: boolean;
}

/**
 * Walk every page of a SurveySparrow paginated endpoint until `has_next_page`
 * is false or `maxPages` is hit. Returns aggregated `data` plus the last status.
 */
export async function fetchAllPages<T>(
  config: SurveySparrowClientConfig,
  basePath: string,
  options: FetchAllPagesOptions = {},
): Promise<FetchAllPagesResult<T>> {
  const maxPages = options.maxPages ?? 50;
  const perPage = Math.min(options.perPage ?? 100, 100);

  const aggregated: T[] = [];
  let page = 1;
  let lastStatus = 0;

  while (page <= maxPages) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = `${basePath}${sep}page=${page}&limit=${perPage}`;
    const res = await surveySparrowFetch<PaginatedResponse<T>>(config, path);
    lastStatus = res.status;
    if (!res.ok) {
      return { ok: false, status: res.status, data: aggregated, error: res.error };
    }
    const body = res.data;
    if (!body || !Array.isArray(body.data)) {
      // Some endpoints might return an unwrapped array; treat that as a single page.
      if (Array.isArray(body)) {
        aggregated.push(...(body as T[]));
        return { ok: true, status: lastStatus, data: aggregated };
      }
      return {
        ok: false,
        status: res.status,
        data: aggregated,
        error: "Unexpected response shape from SurveySparrow.",
      };
    }
    aggregated.push(...body.data);
    if (!body.has_next_page) {
      return { ok: true, status: lastStatus, data: aggregated };
    }
    page += 1;
  }

  return {
    ok: true,
    status: lastStatus,
    data: aggregated,
    truncated: true,
  };
}
