// SSE streaming route for Phase 5a response generation.
//
// POST /api/llm/responses
// Body: {
//   personas: Persona[],
//   questions: Question[],
//   surveyContext: { surveyName, surveyDescription?, useCase, themes },
//   credentials: { provider, apiKey, responseModel },
// }
//
// Streams Server-Sent Events:
//   event: progress | warning | complete | error
//   data:  JSON payload (see GenerateResponsesEvent)
//
// SECURITY: API keys are taken from the request body (not env), never
// logged, and are scoped to this request only.

import { type NextRequest } from "next/server";
import {
  generateResponses,
  type GenerateResponsesInput,
} from "@/lib/generation/response-generator";
import type { GenerateResponsesEvent } from "@/lib/generation/response-types";
import {
  getModel,
  getProviderLabel,
  isKnownProvider,
  type LLMProvider,
} from "@/lib/llm/models";
import type { Persona } from "@/lib/generation/persona-types";
import type { Question } from "@/lib/surveysparrow/types";
import type { SurveyContext } from "@/lib/llm/prompts/response-prompt";
import { installDisconnectSuppressor } from "@/lib/server/disconnect-suppressor";

export const runtime = "nodejs";
// Long-running stream — bump server-side timeout. Vercel default is 10s
// for serverless; 5 minutes covers a 1000-response run at ~200ms/response
// with full concurrency.
export const maxDuration = 300;

// Quiet the harmless ECONNRESET / "aborted" errors that undici emits async
// after a client-cancelled fetch. Idempotent.
installDisconnectSuppressor();

interface RequestBody {
  personas?: Persona[];
  questions?: Question[];
  surveyContext?: SurveyContext;
  credentials?: {
    provider?: string;
    apiKey?: string;
    responseModel?: string;
    /** OpenRouter only — required when `responseModel` is the `openrouter:custom` sentinel. */
    customResponseModelId?: string;
  };
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError(400, "Invalid request body — must be JSON.");
  }

  const error = validateRequest(body);
  if (error) return jsonError(400, error);

  // Narrowed by `validateRequest`.
  const personas = body.personas!;
  const questions = body.questions!;
  const surveyContext = body.surveyContext!;
  const credentials = body.credentials!;
  const provider = credentials.provider as LLMProvider;
  const apiKey = credentials.apiKey!;
  const responseModel = credentials.responseModel!;
  const customResponseModelId = credentials.customResponseModelId;

  const signal = req.signal;
  const input: GenerateResponsesInput = {
    personas,
    questions,
    surveyContext,
    credentials: { provider, apiKey, responseModel, customResponseModelId },
    signal,
  };
  const stream = createSSEStream(generateResponses(input), signal);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function validateRequest(body: RequestBody): string | null {
  if (!Array.isArray(body.personas) || body.personas.length === 0) {
    return "`personas` must be a non-empty array.";
  }
  if (body.personas.length > 5_000) {
    return "`personas` exceeds the 5,000 maximum.";
  }
  if (!Array.isArray(body.questions)) {
    return "`questions` must be an array.";
  }
  if (!body.surveyContext || typeof body.surveyContext !== "object") {
    return "Missing `surveyContext`.";
  }
  if (typeof body.surveyContext.surveyName !== "string") {
    return "`surveyContext.surveyName` must be a string.";
  }
  if (!Array.isArray(body.surveyContext.themes)) {
    return "`surveyContext.themes` must be an array.";
  }
  if (!body.credentials || typeof body.credentials !== "object") {
    return "Missing `credentials`.";
  }
  if (!isKnownProvider(body.credentials.provider)) {
    return "`credentials.provider` is not a supported LLM provider.";
  }
  if (typeof body.credentials.apiKey !== "string" || body.credentials.apiKey.length === 0) {
    return "`credentials.apiKey` is required.";
  }
  if (typeof body.credentials.responseModel !== "string") {
    return "`credentials.responseModel` is required.";
  }
  const provider = body.credentials.provider;
  const known = getModel(body.credentials.responseModel);
  if (!known || known.provider !== provider) {
    return `Model "${body.credentials.responseModel}" is not available for ${getProviderLabel(provider)}.`;
  }
  if (provider === "openrouter" && body.credentials.responseModel === "openrouter:custom") {
    if (
      typeof body.credentials.customResponseModelId !== "string" ||
      body.credentials.customResponseModelId.trim().length === 0
    ) {
      return "`credentials.customResponseModelId` is required when using the OpenRouter custom-model option.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE stream construction
//
// Same defensive pattern as `app/api/llm/personas/route.ts` — the consumer
// may go away mid-stream, so every controller op is guarded by a
// `consumerGone` flag set from both `req.signal.abort` AND the stream's
// `cancel` callback. Without this, undici's async post-disconnect errors
// crash the dev server.
// ---------------------------------------------------------------------------

function createSSEStream(
  generator: AsyncGenerator<GenerateResponsesEvent, void, void>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let consumerGone = signal.aborted;
  if (!consumerGone) {
    signal.addEventListener(
      "abort",
      () => {
        consumerGone = true;
      },
      { once: true },
    );
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (consumerGone) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          consumerGone = true;
          return false;
        }
      };

      // Initial comment line keeps proxies from buffering.
      safeEnqueue(encoder.encode(": stream-open\n\n"));

      try {
        for await (const event of generator) {
          if (consumerGone) break;
          // The orchestrator emits `persona_warning`; we serialize it as
          // `event: warning` for a stable SSE event-name surface (matches
          // the personas route convention).
          const eventType =
            event.type === "persona_warning" ? "warning" : event.type;
          const payload = JSON.stringify(event);
          if (
            !safeEnqueue(
              encoder.encode(`event: ${eventType}\ndata: ${payload}\n\n`),
            )
          ) {
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const payload = JSON.stringify({ type: "error", message });
        safeEnqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`));
      } finally {
        if (!consumerGone) {
          try {
            controller.close();
          } catch {
            /* already closed / cancelled — ignore */
          }
        }
      }
    },
    cancel() {
      consumerGone = true;
    },
  });
}

// ---------------------------------------------------------------------------
// JSON error helper (for pre-stream validation failures)
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
