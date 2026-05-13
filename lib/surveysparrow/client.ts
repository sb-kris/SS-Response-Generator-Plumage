import { getRegion, type SurveySparrowRegion } from "./regions";
import { beginLog, finishLog } from "@/lib/server/api-log-buffer";

export interface SurveySparrowClientConfig {
  region: SurveySparrowRegion;
  apiKey: string;
}

export interface SurveySparrowFetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/**
 * Thin authenticated fetch wrapper for the SurveySparrow REST API.
 * Returns a structured result rather than throwing — callers decide UX based on `ok` + `status`.
 */
export async function surveySparrowFetch<T = unknown>(
  config: SurveySparrowClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<SurveySparrowFetchResult<T>> {
  const region = getRegion(config.region);
  if (!region) {
    return { ok: false, status: 0, error: `Unknown region: ${config.region}` };
  }
  if (!config.apiKey) {
    return { ok: false, status: 0, error: "Missing API key" };
  }

  const url = new URL(path, region.baseUrl).toString();
  const method = (init.method ?? "GET").toUpperCase();
  const mergedHeaders = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(init.headers ?? {}),
  };
  const requestBodyText = typeof init.body === "string" ? init.body : undefined;
  const logId = beginLog({
    kind: "surveysparrow",
    provider: "surveysparrow",
    method,
    endpoint: url,
    requestHeaders: mergedHeaders as Record<string, string>,
    // Body capture: only stringified bodies. Other shapes (FormData, Blob)
    // are rare for our use and not useful in the logs view.
    requestBody: requestBodyText,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: mergedHeaders,
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network request failed";
    const errorMsg = `Network error: ${message}`;
    finishLog({
      id: logId,
      httpStatus: 0,
      status: /abort/i.test(message) ? "aborted" : "network_error",
      error: errorMsg,
    });
    return { ok: false, status: 0, error: errorMsg };
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const errMsg = extractErrorMessage(parsed, res.status);
    finishLog({
      id: logId,
      httpStatus: res.status,
      error: errMsg,
      responseHeaders: headersToRecord(res.headers),
      responseBody: text,
    });
    return { ok: false, status: res.status, error: errMsg };
  }

  finishLog({
    id: logId,
    httpStatus: res.status,
    responseHeaders: headersToRecord(res.headers),
    responseBody: text,
  });
  return { ok: true, status: res.status, data: parsed as T };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body.length > 0) return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const candidates = [obj.message, obj.error, obj.detail, obj.errorMessage];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
  }
  switch (status) {
    case 401:
      return "401 Unauthorized — check your API key.";
    case 403:
      return "403 Forbidden — this API key lacks permission for this resource.";
    case 404:
      return "404 Not Found — endpoint or workspace not found for this region.";
    case 429:
      return "429 Too Many Requests — rate limited by SurveySparrow.";
    default:
      return `HTTP ${status} — request to SurveySparrow failed.`;
  }
}
