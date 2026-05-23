// Phase 8b — Anthropic Messages call with the `web_search` tool enabled.
//
// Mirrors `callAnthropic` from json-call.ts in shape (same headers, same
// log instrumentation, same return type) but adds:
//
//   - `tools: [{ type: "web_search_20250305", name: "web_search", max_uses }]`
//     so the model can issue search queries inside the API call.
//   - A multi-block response parser. The Messages API streams back
//     `tool_use` / `server_tool_use` / `web_search_tool_result` /
//     `text` blocks; we want the LAST text block as the model's final
//     answer (the JSON brief).
//
// SECURITY: same as the base callAnthropic — API key flows in via the
// request, used once, never persisted. Search results are server-executed
// by Anthropic; we never see the raw HTML or store URLs.

import { beginLog, finishLog } from "@/lib/server/api-log-buffer";
import type { LLMJsonInput, LLMJsonResult } from "@/lib/llm/json-call";

const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_TIMEOUT_MS = 60_000;
// Cap the model at 5 search queries per call. Each web search counts
// against the Anthropic web-search quota; 5 is enough for "research a
// company" without runaway.
const DEFAULT_MAX_SEARCHES = 5;

export interface AnthropicSearchInput extends LLMJsonInput {
  /** Cap on web_search tool calls the model can make. Default 5. */
  maxSearches?: number;
}

export async function callAnthropicWithSearch(
  input: AnthropicSearchInput,
): Promise<LLMJsonResult> {
  const { signal, cleanup } = composeSignal(input);
  const endpoint = "https://api.anthropic.com/v1/messages";

  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    system: input.systemPrompt,
    messages: [{ role: "user", content: input.userPrompt }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: input.maxSearches ?? DEFAULT_MAX_SEARCHES,
      },
    ],
  });

  const logId = beginLog({
    kind: "llm",
    provider: "anthropic",
    method: "POST",
    endpoint,
    contextLabel: "setup-assistant-with-search",
    requestHeaders: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    requestBody,
  });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal,
      cache: "no-store",
    });
  } catch (err) {
    cleanup();
    const aborted = signal.aborted;
    const errorMsg = err instanceof Error ? err.message : "Network error.";
    finishLog({
      id: logId,
      httpStatus: 0,
      status: aborted ? "aborted" : "network_error",
      error: errorMsg,
    });
    return { ok: false, json: null, rawText: "", status: 0, error: errorMsg };
  }
  cleanup();

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Body read failed.";
    finishLog({ id: logId, httpStatus: res.status, error: errorMsg });
    return { ok: false, json: null, rawText: "", status: res.status, error: errorMsg };
  }

  if (!res.ok) {
    // Mirror the base callAnthropic rate-limit detection — we just
    // re-use the simple "429" path here without importing the private
    // helpers from json-call.ts. The setup-assistant route doesn't
    // implement rate-limit retries (one-and-done call), but we still
    // surface the flag so the UI could show a clearer message later.
    const rateLimited = res.status === 429;
    const errorMsg = extractError(text) ?? `Anthropic returned HTTP ${res.status}.`;
    finishLog({
      id: logId,
      httpStatus: res.status,
      status: rateLimited ? "rate_limited" : undefined,
      error: errorMsg,
      responseHeaders: headersToRecord(res.headers),
      responseBody: text,
    });
    return {
      ok: false,
      json: null,
      rawText: text,
      status: res.status,
      error: errorMsg,
      ...(rateLimited
        ? { rateLimited: true, retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) }
        : {}),
    };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    const errorMsg = "Anthropic returned non-JSON envelope.";
    finishLog({
      id: logId,
      httpStatus: res.status,
      status: "server_error",
      error: errorMsg,
      responseHeaders: headersToRecord(res.headers),
      responseBody: text,
    });
    return { ok: false, json: null, rawText: text, status: res.status, error: errorMsg };
  }

  // Pull out the LAST text block — Anthropic puts the model's final
  // answer at the end after any tool_use / search_result blocks.
  const finalText = extractFinalTextBlock(envelope);

  finishLog({
    id: logId,
    httpStatus: res.status,
    responseHeaders: headersToRecord(res.headers),
    responseBody: text,
  });

  // The model is told to output JSON only — try to parse the final text
  // as JSON. Strip a leading/trailing markdown fence if the model
  // ignored the "no fences" instruction.
  const stripped = stripJsonFence(finalText.trim());
  try {
    const json = JSON.parse(stripped);
    return { ok: true, json, rawText: stripped, status: res.status };
  } catch (err) {
    const errorMsg =
      "Final text block didn't parse as JSON: " +
      (err instanceof Error ? err.message : String(err));
    return { ok: false, json: null, rawText: stripped, status: res.status, error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFinalTextBlock(envelope: unknown): string {
  if (!envelope || typeof envelope !== "object") return "";
  const content = (envelope as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  // Walk backwards so we grab the LAST text block — that's the model's
  // final synthesis after any tool calls.
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
      const t = (c as Record<string, unknown>).text;
      if (typeof t === "string") return t;
    }
  }
  return "";
}

function stripJsonFence(s: string): string {
  // ```json\n…\n``` or ```\n…\n``` — same heuristic the base json-call uses.
  const fenced = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1]!.trim() : s;
}

function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const env = JSON.parse(body) as Record<string, unknown>;
    if (env && typeof env === "object") {
      const e = env.error;
      if (e && typeof e === "object") {
        const m = (e as Record<string, unknown>).message;
        if (typeof m === "string" && m.trim()) return m.trim();
      }
      const m2 = env.message;
      if (typeof m2 === "string" && m2.trim()) return m2.trim();
    }
  } catch {
    /* fall through */
  }
  return body.slice(0, 200);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = parseFloat(header);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  return undefined;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Compose the user's external AbortSignal with an internal timeout. Lifted
 * from json-call.ts's pattern so behaviour matches (timeout cancels the
 * fetch, but doesn't leak the timer if the request completes first).
 */
function composeSignal(input: AnthropicSearchInput): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const externalAbort = () => ctrl.abort();
  if (input.signal) {
    if (input.signal.aborted) ctrl.abort();
    else input.signal.addEventListener("abort", externalAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", externalAbort);
    },
  };
}
