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
// Enough headroom for the submit + first 4s wait + up to 17 × 3s polls
// (= 55s of pure waits) + per-poll HTTP overhead.
export const maxDuration = 75;

// Verified SS cadence: wait 4s after batch submit before the FIRST poll
// (gives SS time to enqueue), then wait 3s between subsequent polls.
const FIRST_POLL_DELAY_MS = 4_000;
const POLL_INTERVAL_MS = 3_000;
// 18 polls × ~3.5s budget each ≈ 63s — well inside maxDuration.
const MAX_POLLS = 18;

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
  //
  // CRITICAL: an HTTP 200 from the status endpoint only means SS answered
  // our poll — it does NOT mean the batch succeeded. We must inspect the
  // response body for:
  //   (a) a terminal top-level status (completed / failed / done), and
  //   (b) the per-response items inside (each carries its own status +
  //       message — e.g. `{"status":"failed","message":"Channel not found"}`).
  // The previous version assumed top-level numeric counts (`processed_responses`
  // / `failed_responses`) which SS doesn't always send, so a fully-failed
  // batch was being reported as a clean success.
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    // First poll gives SS 4 seconds to enqueue; subsequent polls wait 3s.
    // Cadence verified against the user's actual SS interaction trace.
    await sleep(attempt === 0 ? FIRST_POLL_DELAY_MS : POLL_INTERVAL_MS);

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
        // Up to 3 unique failure reasons — the UI shows these in the
        // partial-failure alert so the SE can debug without opening logs.
        failureReasons: statusResult.failureReasons,
        // Server-side echo of the terminal status SS reported (e.g.
        // "completed", "failed", "partially_completed"). Useful when
        // "completed" hides individual failures.
        terminalStatus: statusResult.terminalStatus,
      });
    }
  }

  // Timeout — SS never returned a terminal status. We surface this as
  // ok:false with `timedOut:true` so the UI can show "couldn't confirm"
  // language (the SE checks SS dashboard to verify). The PREVIOUS
  // misleading-success path is gone; we no longer claim the batch
  // succeeded just because polling ran out.
  const totalWaitSeconds = Math.round(
    (FIRST_POLL_DELAY_MS + (MAX_POLLS - 1) * POLL_INTERVAL_MS) / 1000,
  );
  return NextResponse.json({
    ok: false,
    status: 202,
    submitted,
    processed: 0,
    failed: 0,
    error: `Couldn't confirm completion after ${totalWaitSeconds}s of polling. SS may have finalised the batch in the background — check the survey's response list before pushing again to avoid duplicates.`,
    timedOut: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface InterpretedStatus {
  /** True only when SS has reported a terminal state. "started" / "pending" /
   *  "in_progress" / "running" / "queued" do NOT count as done — we keep
   *  polling for those. "completed" / "failed" / "error" / "done" / "success"
   *  are all terminal (failed-completion is still completion). */
  done: boolean;
  /** Count of responses SS reports as successful. Derived first from explicit
   *  numeric fields if present, otherwise by counting items in the per-response
   *  array whose individual status is "success" / "ok" / "created" / "accepted". */
  processed: number;
  /** Count of responses SS reports as failed. Derived from the per-response
   *  array — the previous version trusted a non-existent `failed_responses`
   *  top-level field and missed all failures. */
  failed: number;
  /** Up to 3 unique human-readable failure reasons gleaned from the
   *  per-response items. Surfaced to the UI for debugging. */
  failureReasons: string[];
  /** Raw terminal status string SS returned ("COMPLETED", "FAILED", etc.).
   *  Empty string when undetermined. */
  terminalStatus: string;
}

/**
 * Probe the polling response for completion + per-response outcomes.
 *
 * Verified SS batch-status response shapes (May 2026):
 *
 *   In-progress:
 *     { "status": "started" }
 *
 *   All succeeded:
 *     { "status": "completed",
 *       "data": [
 *         { "status": "success", "result": { "id": 1005414422, "state": "COMPLETED", "time_taken": 0 } },
 *         ...
 *       ]
 *     }
 *
 *   All failed:
 *     { "status": "failed",
 *       "data": [
 *         { "status": "failed", "message": "Channel not found" },
 *         ...
 *       ]
 *     }
 *
 *   Mixed:
 *     { "status": "partially_completed",
 *       "data": [
 *         { "status": "failed",  "message": "Channel not found" },
 *         { "status": "success", "result": { ... } },
 *         ...
 *       ]
 *     }
 *
 * IMPORTANT — previously broken: this function used to "unwrap" a `.data`
 * envelope. But SS's `data` field IS the items array, not a wrapper. The
 * unwrap pointed `obj` at the array, then `obj.status` was undefined and
 * the function returned in-progress every time. Polling timed out at 60s
 * even though SS had reported "completed" on the first poll — exactly
 * the symptom shown in the screenshot. The fix: read `body.status` and
 * `body.data` directly, no unwrap.
 */
function interpretStatusResponse(
  data: unknown,
  submitted: number,
): InterpretedStatus {
  const EMPTY: InterpretedStatus = {
    done: false,
    processed: 0,
    failed: 0,
    failureReasons: [],
    terminalStatus: "",
  };
  if (!data || typeof data !== "object") return EMPTY;

  const body = data as Record<string, unknown>;
  const rawStatus =
    typeof body.status === "string" ? body.status.toUpperCase() :
    typeof body.state === "string" ? body.state.toUpperCase() : "";

  // In-progress states — keep polling. Explicit list rather than "not in
  // terminal list" so any unrecognised SS state defaults to "keep
  // polling" (safer than prematurely declaring it done).
  const inProgress =
    rawStatus === "STARTED" ||
    rawStatus === "IN_PROGRESS" ||
    rawStatus === "INPROGRESS" ||
    rawStatus === "PENDING" ||
    rawStatus === "RUNNING" ||
    rawStatus === "QUEUED" ||
    rawStatus === "PROCESSING" ||
    rawStatus === "";

  if (inProgress) {
    return { ...EMPTY, terminalStatus: rawStatus };
  }

  // Terminal — count items in `body.data` (the per-response array). The
  // top-level status is informative (COMPLETED / FAILED / PARTIALLY_COMPLETED)
  // but we don't trust it alone — we count successes/failures ourselves
  // because "completed" can hide individual failures and vice versa.
  const items = Array.isArray(body.data) ? body.data : [];

  let processed = 0;
  let failed = 0;
  const reasonsSet = new Set<string>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const itStatus =
      typeof it.status === "string" ? it.status.toLowerCase() :
      typeof it.state === "string" ? it.state.toLowerCase() : "";
    if (itStatus === "failed" || itStatus === "error" || itStatus === "fail") {
      failed += 1;
      const msg =
        firstString(it.message, it.error, it.reason, it.error_message) ??
        "Unspecified failure";
      reasonsSet.add(msg);
    } else if (
      itStatus === "success" ||
      itStatus === "completed" ||
      itStatus === "ok" ||
      itStatus === "accepted" ||
      itStatus === "created"
    ) {
      processed += 1;
    }
    // Items with an unrecognised status are ignored — neither processed
    // nor failed. This prevents over-counting from format drift.
  }

  // Fallback: terminal status but no items array. Trust the top-level
  // status label. Rare in practice — SS sends items on every terminal
  // status we've observed.
  if (items.length === 0) {
    const allFailed = rawStatus === "FAILED" || rawStatus === "ERROR";
    processed = allFailed ? 0 : submitted;
    failed = allFailed ? submitted : 0;
  }

  return {
    done: true,
    processed,
    failed,
    failureReasons: Array.from(reasonsSet).slice(0, 3),
    terminalStatus: rawStatus,
  };
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}
