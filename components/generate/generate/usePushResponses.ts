"use client";

import { useCallback, useRef } from "react";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { loggedFetch } from "@/store/api-logs-store";
import { buildSSBatchPayload } from "@/lib/surveysparrow/response-builder";

// Phase 5c — orchestrates pushing generated responses to SurveySparrow.
//
// Architecture: client groups all "generated" responses into batches of ≤200
// and calls POST /api/surveysparrow/responses once per batch. The route
// calls SS /v3/responses/batch (which supports contact creation) and polls
// the status token server-side until done.
//
// One batch per call means at most ceil(N/200) HTTP calls for N responses —
// much more efficient than the previous per-response approach, and the only
// way to include contact data in the single-call flow.

// SS /v3/responses/batch accepts up to 200 responses per call (asynchronous,
// returns a polling token). We push at 100/batch — half the SS ceiling —
// because a smaller batch gives meaningful progress-bar movement for
// medium runs (200–500 responses) without doubling our HTTP overhead.
// For a 500-response run this is 5 calls instead of the previous 25.
const BATCH_SIZE = 100;

export interface PushResponsesHookState {
  push: () => Promise<void>;
  /**
   * Re-push the entire response set even if every response has already
   * been pushed once. Use cases:
   *   - The SS API accepted a batch (returned 202) but a silent
   *     downstream failure dropped some responses.
   *   - The user genuinely wants duplicate records in SurveySparrow
   *     (e.g. for a stress-test demo).
   * Implementation: resets every response back to "generated" status so
   * the normal push() filter (`status !== "pushed"`) picks them up.
   */
  pushAgain: () => Promise<void>;
  cancel: () => void;
  canPush: boolean;
  reasonNotReady: string | null;
}

export function usePushResponses(): PushResponsesHookState {
  const responses = useResponsesStore((s) => s.responses);
  const personas = usePersonasStore((s) => s.personas);
  const ss = useSetupStore((s) => s.surveySparrow);
  const ssConnection = useSetupStore((s) => s.ssConnection);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);

  const startPush = useResponsesStore((s) => s.startPush);
  const recordPushResult = useResponsesStore((s) => s.recordPushResult);
  const finishPush = useResponsesStore((s) => s.finishPush);
  const appendDebugLog = useResponsesStore((s) => s.appendDebugLog);

  const abortRef = useRef<AbortController | null>(null);

  const reasonNotReady = computeReasonNotReady({
    ssApiKey: ss.apiKey,
    ssConnectionStatus: ssConnection.status,
    responsesCount: responses.length,
    surveyId: selectedSurveyId,
  });
  const canPush = reasonNotReady === null;

  const push = useCallback(async () => {
    // Idempotency guard — if push already started, don't restart it.
    const currentStatus = useResponsesStore.getState().pushStatus;
    if (currentStatus === "running") return;

    if (!canPush || selectedSurveyId === null) return;
    const surveyId: number = selectedSurveyId;

    const personasById = new Map(personas.map((p) => [p.id, p]));
    // Only push responses that haven't already been successfully pushed.
    const toPush = responses.filter((r) => r.status !== "pushed");

    if (toPush.length === 0) {
      finishPush();
      return;
    }

    startPush(toPush.length);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Build a question-id → parent-question-id lookup for the push payload.
    // Read fresh from the survey store at push time so we always get the
    // current survey's question metadata, not a stale closure value.
    // Without this map, follow-up types like NPSFeedback would push without
    // a parent reference and SurveySparrow would silently drop the answer
    // (rendering "Not Answered" in the response viewer).
    const surveyQuestions = useSurveyStore.getState().questions.data ?? [];
    const questionParents = new Map<number, number>();
    for (const q of surveyQuestions) {
      if (typeof q.parent_question_id === "number") {
        questionParents.set(q.id, q.parent_question_id);
      }
    }

    // Build (response, persona) pairs, skipping any orphaned responses.
    const pairs: Array<{ responseId: string; personaName: string; response: typeof toPush[0]; persona: ReturnType<typeof personasById.get> }> = [];
    for (const response of toPush) {
      const persona = personasById.get(response.personaId);
      if (!persona) {
        recordPushResult(response.id, false, undefined, "Persona not found in session");
        continue;
      }
      pairs.push({ responseId: response.id, personaName: response.personaName, response, persona });
    }

    const totalBatches = Math.ceil(pairs.length / BATCH_SIZE);

    // Read tags from the generation draft once per push run (not per batch).
    // Using .getState() avoids a hook call inside the callback while still
    // capturing the value at push-time — consistent with other .getState()
    // reads in this file.
    const tagsConfig = useGenerationStore.getState().draft.systemMetadata.tags;
    const tags =
      tagsConfig.enabled && tagsConfig.values.length > 0
        ? tagsConfig.values
        : undefined;

    // Process in batches of BATCH_SIZE.
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      if (ctrl.signal.aborted) break;

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batch = pairs.slice(i, i + BATCH_SIZE);
      const payload = buildSSBatchPayload(
        batch.map(({ response, persona }) => ({ response, persona: persona! })),
        surveyId,
        {
          triggerWorkflow: ss.triggerWorkflow,
          channels: ss.channelsEnabled && ss.channels.length > 0
            ? ss.channels.map((c) => ({ channelId: c.channelId, weight: c.weight }))
            : [],
          tags,
          questionParents,
        },
      );

      appendDebugLog({
        time: Date.now(),
        kind: "batch_start",
        label: `Batch ${batchNum}/${totalBatches} — sending ${batch.length} response${batch.length === 1 ? "" : "s"}`,
      });

      let result: {
        ok: boolean;
        submitted?: number;
        processed?: number;
        failed?: number;
        error?: string;
        accepted?: boolean;
        timedOut?: boolean;
        /** Up to 3 unique human-readable reasons from per-response items. */
        failureReasons?: string[];
        /** Raw SS-side terminal status — surfaced for debugging. */
        terminalStatus?: string;
      };
      try {
        const res = await loggedFetch(
          "/api/surveysparrow/responses",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ region: ss.region, apiKey: ss.apiKey, payload }),
            signal: ctrl.signal,
            cache: "no-store",
          },
          { kind: "internal", provider: "plumage", contextLabel: `push-batch-${batchNum}` },
        );
        result = await res.json() as typeof result;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          break;
        }
        const msg = err instanceof Error ? err.message : "Network error";
        appendDebugLog({ time: Date.now(), kind: "batch_fail", label: `Batch ${batchNum}/${totalBatches} — network error`, detail: msg });
        for (const { responseId } of batch) {
          recordPushResult(responseId, false, undefined, msg);
        }
        continue;
      }

      if (!result.ok) {
        const errMsg = result.error ?? "Batch failed";
        appendDebugLog({ time: Date.now(), kind: "batch_fail", label: `Batch ${batchNum}/${totalBatches} — API error`, detail: errMsg });
        for (const { responseId } of batch) {
          recordPushResult(responseId, false, undefined, errMsg);
        }
        continue;
      }

      // Mark per-response status based on batch outcome.
      const failedCount = result.failed ?? 0;
      const successCount = batch.length - failedCount;

      // Compose a detail string that captures WHY responses failed when
      // SS gave us reasons. Previously the debug log just said "N failed"
      // with no clue why — the user had to dig through API logs. Now the
      // first ~3 unique reasons land directly in the debug panel.
      const reasonsText =
        result.failureReasons && result.failureReasons.length > 0
          ? `· reasons: ${result.failureReasons.join("; ")}`
          : "";
      const terminalText = result.terminalStatus
        ? ` (SS status: ${result.terminalStatus.toLowerCase()})`
        : "";
      const detailParts: string[] = [];
      if (result.accepted) detailParts.push("accepted (no polling token)");
      if (result.timedOut) detailParts.push("polling timed out — SS may still finalize");
      if (reasonsText) detailParts.push(reasonsText.replace(/^· /, ""));

      appendDebugLog({
        time: Date.now(),
        kind: failedCount > 0 ? "batch_fail" : "batch_ok",
        label: `Batch ${batchNum}/${totalBatches} — ${successCount} pushed${failedCount > 0 ? `, ${failedCount} failed` : ""}${terminalText}`,
        detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
      });

      // SS doesn't report WHICH responses failed in a batch — mark the
      // last `failedCount` entries as failed (order matches submission).
      // When SS gave us reason strings, store the first one against each
      // failed response so the UI can surface specifics (e.g. "Channel
      // not found") rather than a generic "Failed in batch".
      const primaryReason = result.failureReasons?.[0] ?? "Failed in batch";
      for (let j = 0; j < batch.length; j++) {
        const isSuccess = j < successCount;
        recordPushResult(
          batch[j]!.responseId,
          isSuccess,
          undefined,
          isSuccess ? undefined : primaryReason,
        );
      }
    }

    abortRef.current = null;
    finishPush();
  }, [
    appendDebugLog,
    canPush,
    finishPush,
    personas,
    recordPushResult,
    responses,
    selectedSurveyId,
    ss.apiKey,
    ss.region,
    ss.triggerWorkflow,
    ss.channelsEnabled,
    ss.channels,
    startPush,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetPush = useResponsesStore((s) => s.resetPush);

  const pushAgain = useCallback(async () => {
    // Bail if a push is already running — pushing the same set twice in
    // parallel would result in messy split status updates.
    if (useResponsesStore.getState().pushStatus === "running") return;
    // Flip every response back to "generated" so the normal push flow
    // sweeps them up again. Clears `pushedResponseId` and any prior
    // error message so the new attempt starts clean.
    resetPush();
    // resetPush() is a Zustand `set` call — synchronous — so the next
    // `push()` reads the updated status immediately.
    await push();
  }, [push, resetPush]);

  return { push, pushAgain, cancel, canPush, reasonNotReady };
}

// ---------------------------------------------------------------------------
// Readiness guard
// ---------------------------------------------------------------------------

function computeReasonNotReady(input: {
  ssApiKey: string;
  ssConnectionStatus: string;
  responsesCount: number;
  surveyId: number | null;
}): string | null {
  if (!input.ssApiKey) {
    return "SurveySparrow API key not set — go back to Setup.";
  }
  if (input.ssConnectionStatus !== "ok") {
    return "SurveySparrow connection not verified — test it in Setup first.";
  }
  if (input.surveyId === null) {
    return "No survey selected.";
  }
  if (input.responsesCount === 0) {
    return "No responses to push — generate some first.";
  }
  return null;
}
