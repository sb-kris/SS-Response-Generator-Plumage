// Phase 5c — Batch-push generated responses to SurveySparrow.
//
// Uses POST /v3/responses/batch (up to 200 per call) then polls
// GET /v3/responses/status/{token} until the job completes or the
// 30-second server-side timeout elapses.
//
// Why batch instead of single POST /v3/responses:
//   - POST /v3/responses doesn't support contact creation (no `contact` field).
//   - The batch endpoint accepts `contact: { full_name, email, phone }` per item.
//   - One HTTP round-trip for up to 200 responses vs. N separate calls.
//
// SECURITY: region + apiKey are passed in the request body, used once, and
// never stored or logged.

import { NextResponse, type NextRequest } from "next/server";
import { surveySparrowFetch } from "@/lib/surveysparrow/client";
import { getRegion, type SurveySparrowRegion } from "@/lib/surveysparrow/regions";
import type {
  SSBatchPayload,
  SSBatchSubmitResult,
} from "@/lib/surveysparrow/response-builder";

export const runtime = "nodejs";
// Enough headroom for the submit + up to 15 × 2s polls.
export const maxDuration = 45;

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 15;

interface PushBatchRequest {
  region?: string;
  apiKey?: string;
  payload?: SSBatchPayload;
}

export async function POST(req: NextRequest) {
  let body: PushBatchRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const region = body.region as SurveySparrowRegion | undefined;
  if (!region || !getRegion(region)) {
    return NextResponse.json({ ok: false, error: "Select a region." }, { status: 400 });
  }
  if (!body.apiKey) {
    return NextResponse.json({ ok: false, error: "API key is required." }, { status: 400 });
  }
  if (!body.payload) {
    return NextResponse.json({ ok: false, error: "payload is required." }, { status: 400 });
  }

  const config = { region, apiKey: body.apiKey };
  const submitted = body.payload.responses.length;

  // --- 1. Submit batch ---
  const submit = await surveySparrowFetch<SSBatchSubmitResult>(config, "/v3/responses/batch", {
    method: "POST",
    body: JSON.stringify(body.payload),
  });

  if (!submit.ok) {
    return NextResponse.json(
      { ok: false, status: submit.status, error: submit.error ?? "Batch submit failed" },
      { status: 200 },
    );
  }

  const token = submit.data?.token;

  // No token → SS accepted it but won't allow polling (some plan tiers).
  // Return "accepted" so the UI can show a best-effort success.
  if (!token) {
    return NextResponse.json({ ok: true, status: 202, submitted, processed: submitted, failed: 0, accepted: true });
  }

  // --- 2. Poll until done ---
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const poll = await surveySparrowFetch<unknown>(
      config,
      `/v3/responses/status/${encodeURIComponent(token)}`,
    );

    if (!poll.ok) {
      // Transient poll failure — keep trying.
      continue;
    }

    const statusResult = interpretStatusResponse(poll.data, submitted);
    if (statusResult.done) {
      return NextResponse.json({
        ok: true,
        status: poll.status,
        submitted,
        processed: statusResult.processed,
        failed: statusResult.failed,
      });
    }
  }

  // Timeout — batch was accepted but we couldn't confirm completion in time.
  return NextResponse.json({
    ok: true,
    status: 202,
    submitted,
    processed: submitted,
    failed: 0,
    accepted: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe the polling response for completion. SS's API docs don't fully specify
 * the status response shape, so we check multiple candidate field names.
 */
function interpretStatusResponse(
  data: unknown,
  submitted: number,
): { done: boolean; processed: number; failed: number } {
  if (!data || typeof data !== "object") {
    return { done: false, processed: 0, failed: 0 };
  }

  // Unwrap { data: { ... } } envelope if present.
  const obj = (
    "data" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).data
      : data
  ) as Record<string, unknown>;

  const rawStatus =
    typeof obj.status === "string" ? obj.status.toUpperCase() :
    typeof obj.state === "string" ? obj.state.toUpperCase() : "";

  const done =
    rawStatus === "COMPLETED" ||
    rawStatus === "COMPLETE" ||
    rawStatus === "DONE" ||
    rawStatus === "SUCCESS";

  if (!done) return { done: false, processed: 0, failed: 0 };

  const processed =
    typeof obj.processed_responses === "number" ? obj.processed_responses :
    typeof obj.processed === "number" ? obj.processed :
    typeof obj.total_responses === "number" ? obj.total_responses :
    submitted;

  const failed =
    typeof obj.failed_responses === "number" ? obj.failed_responses :
    typeof obj.failed === "number" ? obj.failed : 0;

  return { done: true, processed, failed };
}
