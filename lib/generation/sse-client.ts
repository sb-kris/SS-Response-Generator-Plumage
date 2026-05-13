// SSE client for /api/llm/personas.
//
// We can't use the browser's `EventSource` because it only supports GET — we
// need to POST a sizable JSON body (draft + credentials). Instead we use
// fetch + a streaming response reader and parse SSE frames manually. The
// frame format is:
//
//   event: <name>\n
//   data: <json>\n
//   \n
//
// `:` lines are comments and are ignored.

import type { SynthesizeEvent } from "./persona-synthesizer";
import { loggedFetch } from "@/store/api-logs-store";

export interface SSEStreamInput {
  body: unknown;
  signal?: AbortSignal;
  onEvent: (event: SynthesizeEvent) => void;
}

export interface SSEStreamResult {
  ok: boolean;
  /** HTTP status from the initial response. 0 means transport error. */
  status: number;
  /** Set when `ok` is false. */
  error?: string;
}

export async function streamPersonaSynthesis(
  input: SSEStreamInput,
): Promise<SSEStreamResult> {
  let res: Response;
  try {
    res = await loggedFetch(
      "/api/llm/personas",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.body),
        signal: input.signal,
      },
      { kind: "internal", provider: "plumage", contextLabel: "persona-synthesis" },
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Synthesis cancelled."
          : err.message
        : "Network error.";
    return { ok: false, status: 0, error: message };
  }

  // Pre-stream errors return JSON, not SSE. Detect via status / content-type.
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
      return { ok: false, status: res.status, error: "Synthesis cancelled." };
    }
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      // If the read fails because we aborted, that's not an error — surface
      // it as a clean cancellation so the caller can show the right UI.
      if (input.signal?.aborted || isAbortLike(err)) {
        return { ok: false, status: res.status, error: "Synthesis cancelled." };
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

  // Final flush — server may close without trailing blank line.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const parsed = parseFrame(buffer);
    if (parsed) input.onEvent(parsed);
  }

  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Abort detection
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

function parseFrame(frame: string): SynthesizeEvent | null {
  // Each frame is a series of `field: value` lines. We only care about `data`.
  const lines = frame.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) {
      // Concatenate multi-line data fields with newlines per the SSE spec.
      data += (data ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  if (!data) return null;
  try {
    const json = JSON.parse(data);
    if (json && typeof json === "object" && typeof (json as { type?: unknown }).type === "string") {
      return json as SynthesizeEvent;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}
