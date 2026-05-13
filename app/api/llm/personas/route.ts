// SSE streaming route for Phase 4 persona synthesis.
//
// POST /api/llm/personas
// Body: {
//   draft: ProfileDraft,
//   responseCount: number,
//   surveyContext: { surveyName, surveyDescription?, useCase, themes },
//   credentials: { provider, apiKey, personaModel },
// }
//
// Streams Server-Sent Events:
//   event: progress | warning | complete | error
//   data:  JSON payload (see synthesizePersonas event types)
//
// SECURITY: API keys are taken from the request body (not env), never
// logged, and are scoped to this request only.

import { type NextRequest } from "next/server";
import {
  synthesizePersonas,
  type SynthesizeEvent,
} from "@/lib/generation/persona-synthesizer";
import {
  getModel,
  getProviderLabel,
  isKnownProvider,
  type LLMProvider,
} from "@/lib/llm/models";
import type { ProfileDraft } from "@/lib/profiles/types";
import type { SurveyContext } from "@/lib/llm/prompts/persona-prompt";
import { installDisconnectSuppressor } from "@/lib/server/disconnect-suppressor";

export const runtime = "nodejs";
// Long-running stream — bump server-side timeout. Vercel default is 10s
// for serverless functions; 5 minutes covers a 5,000-persona run.
export const maxDuration = 300;

// Quiet the harmless ECONNRESET / "aborted" errors that undici emits async
// after a client-cancelled fetch. Idempotent.
installDisconnectSuppressor();

interface RequestBody {
  draft?: ProfileDraft;
  responseCount?: number;
  surveyContext?: SurveyContext;
  credentials?: {
    provider?: string;
    apiKey?: string;
    personaModel?: string;
    /** OpenRouter only — required when personaModel is the `openrouter:custom` sentinel. */
    customPersonaModelId?: string;
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
  const draft = body.draft!;
  const responseCount = body.responseCount!;
  const surveyContext = body.surveyContext!;
  const credentials = body.credentials!;
  const provider = credentials.provider as LLMProvider;
  const apiKey = credentials.apiKey!;
  const personaModel = credentials.personaModel!;
  const customPersonaModelId = credentials.customPersonaModelId;

  // Wire the request's abort signal into the synthesizer so cancelling
  // the fetch on the client also cancels in-flight LLM calls.
  const signal = req.signal;
  const stream = createSSEStream(
    synthesizePersonas({
      draft,
      responseCount,
      surveyContext,
      credentials: { provider, apiKey, personaModel, customPersonaModelId },
      signal,
    }),
    signal,
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Next.js / proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function validateRequest(body: RequestBody): string | null {
  if (!body.draft || typeof body.draft !== "object") {
    return "Missing `draft` (the configured persona profile).";
  }
  if (typeof body.responseCount !== "number" || body.responseCount < 1) {
    return "`responseCount` must be a positive number.";
  }
  if (body.responseCount > 5_000) {
    return "`responseCount` exceeds the 5,000 maximum.";
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
  if (typeof body.credentials.personaModel !== "string") {
    return "`credentials.personaModel` is required.";
  }
  const provider = body.credentials.provider;
  const known = getModel(body.credentials.personaModel);
  if (!known || known.provider !== provider) {
    return `Model "${body.credentials.personaModel}" is not available for ${getProviderLabel(provider)}.`;
  }
  if (provider === "openrouter" && body.credentials.personaModel === "openrouter:custom") {
    if (
      typeof body.credentials.customPersonaModelId !== "string" ||
      body.credentials.customPersonaModelId.trim().length === 0
    ) {
      return "`credentials.customPersonaModelId` is required when using the OpenRouter custom-model option.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE stream construction
// ---------------------------------------------------------------------------

function createSSEStream(
  generator: AsyncGenerator<SynthesizeEvent, void, void>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // The consumer may go away (client clicked Cancel, browser closed, network
  // dropped). Once that happens, every controller op will throw — which Node
  // surfaces as `uncaughtException ECONNRESET`. We track the disconnect via
  // a flag that's set from either the signal handler or the stream's own
  // `cancel` callback, then make every controller op a no-op.
  let consumerGone = signal.aborted;
  if (!consumerGone) {
    signal.addEventListener("abort", () => {
      consumerGone = true;
    }, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (consumerGone) return false;
        try {
          controller.enqueue(data);
          return true;
        } catch {
          // Controller errored — typically because the underlying response
          // writer was severed. Treat as "consumer gone" and stop sending.
          consumerGone = true;
          return false;
        }
      };

      // Initial comment line keeps proxies from buffering.
      safeEnqueue(encoder.encode(": stream-open\n\n"));

      try {
        for await (const event of generator) {
          if (consumerGone) break;
          const eventType =
            event.type === "batch_warning" ? "warning" : event.type;
          const payload = JSON.stringify(event);
          if (!safeEnqueue(encoder.encode(`event: ${eventType}\ndata: ${payload}\n\n`))) {
            // Don't keep iterating the generator if we can't deliver events.
            // The generator's own abort-signal check will exit it cleanly.
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
      // The runtime calls this when the consumer aborts. Signal the same
      // gone-flag so the start loop exits.
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
