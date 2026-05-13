// SSE client for /api/llm/responses.
//
// Identical structure to `lib/generation/sse-client.ts` — fetch + streaming
// reader + manual SSE frame parser. We can't use `EventSource` because it
// only supports GET; we need to POST a sizable JSON body (personas +
// questions + credentials).
//
// Frame format:
//   event: <name>\n
//   data: <json>\n
//   \n

import type { GenerateResponsesEvent } from "./response-types";
import { loggedFetch } from "@/store/api-logs-store";

export interface SSEResponsesStreamInput {
  body: unknown;
  signal?: AbortSignal;
  onEvent: (event: GenerateResponsesEvent) => void;
}

export interface SSEResponsesStreamResult {
  ok: boolean;
  /** HTTP status from the initial response. 0 means transport error. */
  status: number;
  /** Set when `ok` is false. */
  error?: string;
}

export async function streamResponseGeneration(
  input: SSEResponsesStreamInput,
): Promise<SSEResponsesStreamResult> {
  let res: Response;
  try {
    res = await loggedFetch(
      "/api/llm/responses",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.body),
        signal: input.signal,
      },
      { kind: "internal", provider: "plumage", contextLabel: "response-generation" },
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Generation cancelled."
          : err.message
        : "Network error.";
    return { ok: false, status: 0, error: message };
  }

  // Pre-stream errors return JSON. Detect via status / content-type.
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok && !contentType.startsWith("text/event-stream")) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body === "object" && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, error: message };
  }
  if (!res.body) {
    return { ok: false, status: res.status, error: "Empty stream response." };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    if (input.signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error: "Generation cancelled." };
    }
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (input.signal?.aborted || isAbortLike(err)) {
        return { ok: false, status: res.status, error: "Generation cancelled." };
      }
      const message = err instanceof Error ? err.message : "Stream read failed.";
      return { ok: false, status: res.status, error: message };
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    // Parse frames separated by blank lines.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseFrame(frame);
      if (parsed) {
        input.onEvent(parsed);
      }
    }
  }

  // Final flush — server may close without a trailing blank line.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const parsed = parseFrame(buffer);
    if (parsed) input.onEvent(parsed);
  }

  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Abort detection — same heuristic as the personas SSE client.
// ---------------------------------------------------------------------------

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "ECONNRESET") return true;
  if (typeof e.message === "string" && e.message.toLowerCase() === "aborted") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Frame parser
// ---------------------------------------------------------------------------

function parseFrame(frame: string): GenerateResponsesEvent | null {
  const lines = frame.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  if (!data) return null;
  try {
    const json = JSON.parse(data);
    if (
      json &&
      typeof json === "object" &&
      typeof (json as { type?: unknown }).type === "string"
    ) {
      return json as GenerateResponsesEvent;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}
