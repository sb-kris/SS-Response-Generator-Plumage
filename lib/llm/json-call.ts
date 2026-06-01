// Minimal "ask the LLM for a JSON object" helper.
//
// Strategy:
//   - Anthropic: prompt-only JSON + fence stripping (the Messages API doesn't
//     have a `response_format: json_object`).
//   - OpenAI / DeepSeek / Groq / OpenRouter: all speak the same OpenAI Chat
//     Completions wire format with `response_format: { type: "json_object" }`.
//     One shared helper, parameterized on endpoint + headers + provider label.
//   - Google Gemini: native `generateContent` endpoint with
//     `responseMimeType: "application/json"` for guaranteed JSON output.
//
// All providers share:
//   - `composeSignal()` — caller's signal + per-call timeout in one signal.
//   - Rate-limit detection that returns `rateLimited: true` + `retryAfterMs`.
//   - Defensive `res.text()` try/catch.
//   - No prompts, keys, or raw bodies are logged. Errors include the upstream
//     status + a short error message extracted from the body.

import type { LLMProvider } from "./models";
import { beginLog, finishLog } from "@/lib/server/api-log-buffer";

export interface LLMJsonInput {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Generous default — persona batches of 10 fit comfortably in 8k. */
  maxOutputTokens?: number;
  /** Soft timeout — abort the request if the provider hangs. */
  timeoutMs?: number;
  /** External abort signal — e.g. the request's `req.signal`. */
  signal?: AbortSignal;
  /** OpenRouter only — the actual upstream model ID when the user picked
   *  the "Custom model ID" sentinel. If provided, overrides `model` in the
   *  request body but `model` is preserved for error messages / logging. */
  upstreamModelId?: string;
}

export interface LLMJsonResult {
  ok: boolean;
  /** Parsed JSON, or null if parsing/HTTP failed. */
  json: unknown;
  /** Raw text response (for debugging and retry prompts). */
  rawText: string;
  /** HTTP status code. 0 means transport-level error. */
  status: number;
  /** Human-readable error if `ok` is false. */
  error?: string;
  /** Set when the upstream returns 429 with a `Retry-After` header. The
   *  orchestrator is expected to sleep this long and retry without
   *  consuming a validation-retry attempt. */
  retryAfterMs?: number;
  /** True if the upstream rejected the call with a rate-limit error. */
  rateLimited?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 8_000;

export async function callLLMForJson(input: LLMJsonInput): Promise<LLMJsonResult> {
  switch (input.provider) {
    case "anthropic":
      return callAnthropic(input);
    case "openai":
      return callOpenAICompatible(input, OPENAI_CONFIG);
    case "google":
      return callGoogle(input);
    case "deepseek":
      return callOpenAICompatible(input, DEEPSEEK_CONFIG);
    case "groq":
      return callOpenAICompatible(input, GROQ_CONFIG);
    case "openrouter":
      return callOpenAICompatible(input, OPENROUTER_CONFIG);
    default: {
      const _exhaustive: never = input.provider;
      return {
        ok: false,
        json: null,
        rawText: "",
        status: 0,
        error: `Unknown provider: ${String(_exhaustive)}`,
      };
    }
  }
}

// ===========================================================================
// Anthropic — native Messages API (no JSON mode flag)
// ===========================================================================

async function callAnthropic(input: LLMJsonInput): Promise<LLMJsonResult> {
  const { signal, cleanup } = composeSignal(input);
  const endpoint = "https://api.anthropic.com/v1/messages";
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    system: input.systemPrompt,
    messages: [{ role: "user", content: input.userPrompt }],
  });
  const logId = beginLog({
    kind: "llm",
    provider: "anthropic",
    method: "POST",
    endpoint,
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
    const result = transportError(err);
    finishLog({
      id: logId,
      httpStatus: 0,
      status: signal.aborted ? "aborted" : "network_error",
      error: result.error,
    });
    return result;
  }
  cleanup();

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Body read failed";
    finishLog({ id: logId, httpStatus: res.status, error: errorMsg });
    return { ok: false, json: null, rawText: "", status: res.status, error: errorMsg };
  }

  if (!res.ok) {
    const rateLimited = isRateLimited(res, text);
    const errorMsg = friendlyHttpError(
      "Anthropic",
      res.status,
      extractErrorMessageGeneric(text),
    );
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
        ? { rateLimited: true, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) }
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
  const rawText = extractAnthropicText(envelope);
  finishLog({
    id: logId,
    httpStatus: res.status,
    responseHeaders: headersToRecord(res.headers),
    responseBody: text,
  });
  return parseJsonOrError(rawText, res.status, "Anthropic");
}

function extractAnthropicText(envelope: unknown): string {
  if (!envelope || typeof envelope !== "object") return "";
  const content = (envelope as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
        const t = (c as Record<string, unknown>).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .join("");
}

// ===========================================================================
// OpenAI-compatible — used for OpenAI, DeepSeek, Groq, OpenRouter
// ===========================================================================

interface OpenAICompatibleConfig {
  /** Provider label for error messages — e.g. "OpenAI", "DeepSeek", "Groq". */
  label: string;
  /** Full URL of the chat completions endpoint. */
  endpoint: string;
  /** Header builder — different providers want bearer vs. custom. */
  authHeaders: (apiKey: string) => Record<string, string>;
  /** Optional extra headers — OpenRouter wants `HTTP-Referer` + `X-Title`. */
  extraHeaders?: Record<string, string>;
  /** Whether the upstream supports `response_format: { type: "json_object" }`.
   *  All four currently do. If a future OpenAI-compat provider doesn't, set
   *  to false and we fall back to prompt-only JSON + fence stripping. */
  supportsJsonMode: boolean;
}

const OPENAI_CONFIG: OpenAICompatibleConfig = {
  label: "OpenAI",
  endpoint: "https://api.openai.com/v1/chat/completions",
  authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  supportsJsonMode: true,
};

const DEEPSEEK_CONFIG: OpenAICompatibleConfig = {
  label: "DeepSeek",
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  supportsJsonMode: true,
};

const GROQ_CONFIG: OpenAICompatibleConfig = {
  label: "Groq",
  endpoint: "https://api.groq.com/openai/v1/chat/completions",
  authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  supportsJsonMode: true,
};

const OPENROUTER_CONFIG: OpenAICompatibleConfig = {
  label: "OpenRouter",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  // OpenRouter likes a non-empty referer/title — both surface in their
  // analytics. Static strings are fine; we don't leak any user data.
  extraHeaders: {
    "HTTP-Referer": "https://plumage.surveysparrow.internal",
    "X-Title": "Plumage",
  },
  supportsJsonMode: true,
};

// OpenAI's reasoning-tier models (o1/o3/o4 series, GPT-5 series) replaced
// `max_tokens` with `max_completion_tokens` in their chat-completions API.
// Passing `max_tokens` to these models returns a 400:
//   "Unsupported parameter: 'max_tokens' is not supported with this model.
//    Use 'max_completion_tokens' instead."
//
// Older models (GPT-4*, GPT-3.5*) still accept `max_tokens` (technically
// deprecated but accepted with a warning), and crucially the OpenAI-
// compatible third-party endpoints we hit (DeepSeek, Groq, OpenRouter)
// only support `max_tokens` — they haven't picked up the rename. So we
// can't universally switch.
//
// Resolution: match by model-name prefix. Anything starting with `o`+digit
// (o1, o3, o4, ...) or `gpt-5`+ uses the new param. Everything else keeps
// the legacy param. Pattern needs to be liberal enough to absorb future
// reasoning-tier releases without a code change.
const REASONING_MODEL_PATTERN = /^(o\d|gpt-5|gpt-6)/i;

function tokenParamName(model: string): "max_tokens" | "max_completion_tokens" {
  return REASONING_MODEL_PATTERN.test(model) ? "max_completion_tokens" : "max_tokens";
}

async function callOpenAICompatible(
  input: LLMJsonInput,
  cfg: OpenAICompatibleConfig,
): Promise<LLMJsonResult> {
  const { signal, cleanup } = composeSignal(input);
  // OpenRouter custom-model-ID sentinel: the user picked "Custom model" in
  // the UI and the dispatcher passes the real model ID separately.
  const upstreamModel = input.upstreamModelId ?? input.model;
  const tokenParam = tokenParamName(upstreamModel);
  const requestBody = JSON.stringify({
    model: upstreamModel,
    [tokenParam]: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    ...(cfg.supportsJsonMode ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
  });
  const requestHeaders = {
    ...cfg.authHeaders(input.apiKey),
    ...(cfg.extraHeaders ?? {}),
    "Content-Type": "application/json",
  };
  const logId = beginLog({
    kind: "llm",
    provider: cfg.label.toLowerCase(),
    method: "POST",
    endpoint: cfg.endpoint,
    requestHeaders,
    requestBody,
  });

  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
      signal,
      cache: "no-store",
    });
  } catch (err) {
    cleanup();
    const result = transportError(err);
    finishLog({
      id: logId,
      httpStatus: 0,
      status: signal.aborted ? "aborted" : "network_error",
      error: result.error,
    });
    return result;
  }
  cleanup();

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Body read failed";
    finishLog({ id: logId, httpStatus: res.status, error: errorMsg });
    return { ok: false, json: null, rawText: "", status: res.status, error: errorMsg };
  }

  if (!res.ok) {
    const rateLimited = isRateLimited(res, text);
    const errorMsg = friendlyHttpError(
      cfg.label,
      res.status,
      extractErrorMessageGeneric(text),
    );
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
        ? { rateLimited: true, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) }
        : {}),
    };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    const errorMsg = `${cfg.label} returned non-JSON envelope.`;
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
  const rawText = extractOpenAIText(envelope);
  finishLog({
    id: logId,
    httpStatus: res.status,
    responseHeaders: headersToRecord(res.headers),
    responseBody: text,
  });
  return parseJsonOrError(rawText, res.status, cfg.label);
}

function extractOpenAIText(envelope: unknown): string {
  if (!envelope || typeof envelope !== "object") return "";
  const choices = (envelope as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (first && typeof first === "object") {
    const msg = (first as Record<string, unknown>).message;
    if (msg && typeof msg === "object") {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  }
  return "";
}

// ===========================================================================
// Google Gemini — native generateContent endpoint
// ===========================================================================

async function callGoogle(input: LLMJsonInput): Promise<LLMJsonResult> {
  const { signal, cleanup } = composeSignal(input);
  // Strip any `models/` prefix users might paste from copy-pasting Gemini IDs.
  const modelPath = input.model.startsWith("models/") ? input.model : `models/${input.model}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;
  // Gemini takes the key as a URL query param. We pass it that way but log
  // the bare endpoint (without the secret) for the API logs view.
  const url = `${endpoint}?key=${encodeURIComponent(input.apiKey)}`;
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
    generationConfig: {
      // Native JSON output — Gemini guarantees parseable JSON when set.
      responseMimeType: "application/json",
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    },
  });
  const logId = beginLog({
    kind: "llm",
    provider: "google",
    method: "POST",
    endpoint, // logged without the ?key= query string
    requestHeaders: { "Content-Type": "application/json" },
    requestBody,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal,
      cache: "no-store",
    });
  } catch (err) {
    cleanup();
    const result = transportError(err);
    finishLog({
      id: logId,
      httpStatus: 0,
      status: signal.aborted ? "aborted" : "network_error",
      error: result.error,
    });
    return result;
  }
  cleanup();

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Body read failed";
    finishLog({ id: logId, httpStatus: res.status, error: errorMsg });
    return { ok: false, json: null, rawText: "", status: res.status, error: errorMsg };
  }

  if (!res.ok) {
    const rateLimited = isRateLimited(res, text);
    const errorMsg = friendlyHttpError(
      "Google Gemini",
      res.status,
      extractErrorMessageGeneric(text),
    );
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
        ? { rateLimited: true, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) }
        : {}),
    };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    const errorMsg = "Google Gemini returned non-JSON envelope.";
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
  const rawText = extractGeminiText(envelope);
  finishLog({
    id: logId,
    httpStatus: res.status,
    responseHeaders: headersToRecord(res.headers),
    responseBody: text,
  });
  return parseJsonOrError(rawText, res.status, "Google Gemini");
}

function extractGeminiText(envelope: unknown): string {
  // Gemini envelope: { candidates: [{ content: { parts: [{ text: "..." }, ...] } }] }
  if (!envelope || typeof envelope !== "object") return "";
  const candidates = (envelope as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = candidates[0];
  if (!first || typeof first !== "object") return "";
  const content = (first as Record<string, unknown>).content;
  if (!content || typeof content !== "object") return "";
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => {
      if (p && typeof p === "object") {
        const t = (p as Record<string, unknown>).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .join("");
}

// ===========================================================================
// Shared helpers
// ===========================================================================

function parseJsonOrError(
  rawText: string,
  status: number,
  providerLabel: string,
): LLMJsonResult {
  const cleaned = stripJsonFences(rawText);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      json: null,
      rawText,
      status,
      error: `${providerLabel}: failed to parse JSON — ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
  return { ok: true, json, rawText, status };
}

function transportError(err: unknown): LLMJsonResult {
  const message =
    err instanceof Error
      ? err.name === "AbortError"
        ? "Request timed out."
        : err.message
      : "Network request failed";
  return { ok: false, json: null, rawText: "", status: 0, error: message };
}

/**
 * Extract a short error message from a typical JSON error envelope. Falls
 * back to the raw text trimmed to 200 chars if structure isn't recognized.
 * Works for OpenAI-shaped (`{ error: { message } }`), Anthropic-shaped,
 * Gemini-shaped (`{ error: { message, status } }`), and most others.
 */
function extractErrorMessageGeneric(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const err = body.error;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      const code = (err as Record<string, unknown>).code;
      const type = (err as Record<string, unknown>).type;
      if (typeof msg === "string") {
        const prefix =
          typeof type === "string"
            ? `${type}: `
            : typeof code === "string"
              ? `${code}: `
              : "";
        return `${prefix}${msg}`;
      }
    }
    // Some providers surface the message at the top level.
    if (typeof body.message === "string") return body.message;
  } catch {
    // Not JSON — fall through.
  }
  const trimmed = text.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : undefined;
}

function friendlyHttpError(
  providerLabel: string,
  status: number,
  detail: string | undefined,
): string {
  const reason = detail ?? defaultStatusReason(status);
  return `${providerLabel} returned ${status}: ${reason}`;
}

function defaultStatusReason(status: number): string {
  switch (status) {
    case 400:
      return "bad request";
    case 401:
      return "invalid API key";
    case 403:
      return "forbidden — key lacks permission for this model";
    case 404:
      return "model not found";
    case 429:
      return "rate limit exceeded";
    case 500:
      return "upstream server error";
    case 502:
      return "bad gateway";
    case 503:
      return "service unavailable";
    case 504:
      return "gateway timeout";
    default:
      return `HTTP ${status}`;
  }
}

/**
 * Strip ```json ... ``` fences if the model wrapped its JSON in markdown.
 */
function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  return trimmed;
}

/**
 * Build a single AbortSignal that fires when EITHER the caller-provided
 * signal aborts OR the wall-clock timeout elapses. Returns a cleanup
 * function the caller must call after the fetch settles to free resources.
 */
function composeSignal(input: LLMJsonInput): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (input.signal) {
    if (input.signal.aborted) {
      ctrl.abort();
    } else {
      const onAbort = () => ctrl.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      cleanupListeners.set(ctrl, () => input.signal!.removeEventListener("abort", onAbort));
    }
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      const detach = cleanupListeners.get(ctrl);
      if (detach) {
        detach();
        cleanupListeners.delete(ctrl);
      }
    },
  };
}

const cleanupListeners = new WeakMap<AbortController, () => void>();

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

/**
 * Rate-limit signal across providers. All five use HTTP 429 as the primary
 * indicator. Anthropic, OpenAI, DeepSeek, and Groq additionally include a
 * `rate_limit*` error type in the body — useful as belt-and-braces when a
 * proxy strips the status. Gemini uses 429 + `RESOURCE_EXHAUSTED`.
 */
function isRateLimited(res: Response, body: string): boolean {
  if (res.status === 429) return true;
  if (res.status >= 400 && res.status < 500) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const err = parsed.error as Record<string, unknown> | undefined;
      const errType = err?.type;
      const errStatus = err?.status;
      if (
        typeof errType === "string" &&
        errType.toLowerCase().includes("rate_limit")
      ) {
        return true;
      }
      if (
        typeof errStatus === "string" &&
        errStatus.toUpperCase() === "RESOURCE_EXHAUSTED"
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Convert a `Headers` instance into a plain record for logging. We don't
 * scrub here — the buffer's `scrubHeaders()` runs on read. The volume is
 * small (response headers are typically <30 entries).
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Parse a `Retry-After` header value. Returns null if missing/unparseable.
 * Providers send seconds as a plain integer. Spec also allows an HTTP-date.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(1000, date - Date.now());
  }
  return undefined;
}
