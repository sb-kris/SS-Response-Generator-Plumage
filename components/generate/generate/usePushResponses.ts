"use client";

import { useCallback, useRef } from "react";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { loggedFetch } from "@/store/api-logs-store";
import { buildSSBatchPayload } from "@/lib/surveysparrow/response-builder";
import { ensureSurveyVariablesExist } from "@/lib/surveysparrow/ensure-variables";

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

    // ------------------------------------------------------------------
    // Phase 8c — Pre-push: ensure every custom variable in the draft
    // already exists in the SurveySparrow workspace. If any are missing
    // (typically when the AI Setup Assistant just suggested them), we
    // create them via POST /v3/variables/batch BEFORE the response push,
    // otherwise SS rejects the payload with a generic "variable not
    // found" error that surfaced as "survey generation failed" in the
    // earlier flow.
    //
    // The helper returns a structured result with ok + counts + error
    // message; we surface those via the store so the push card can
    // show "Checking variables…" → "Creating 3 missing variables…" →
    // "Variables ready: 5 existing, 2 created" inline.
    // ------------------------------------------------------------------
    const setPushPhase = useResponsesStore.getState().setPushPhase;
    const setVariableStats = useResponsesStore.getState().setVariableStats;

    // Persona-bound variables (FIRST_NAME, LAST_NAME, CUSTOMER_EMAIL,
    // etc.) that the readiness check tells us SS auto-populates from
    // contact info. Captured here so the batch loop below can pass them
    // to the response-builder; SS rejects responses that include explicit
    // values for these variables.
    //
    // Default empty — covered by the no-draft-variables fast path which
    // won't populate the readiness check.
    let excludeVariableNames: string[] = [];
    // DATE-typed SS variables that need ISO 8601 datetime formatting at
    // push time. SS rejects YYYY-MM-DD on DATE columns with the
    // misleading "Custom Property not found" error.
    let dateVariableNames: string[] = [];

    const draftCustomVariables = useGenerationStore.getState().draft.customVariables;
    if (draftCustomVariables.length > 0) {
      setPushPhase("checking_variables");
      appendDebugLog({
        time: Date.now(),
        kind: "batch_start",
        label: `Checking ${draftCustomVariables.length} draft variable${draftCustomVariables.length === 1 ? "" : "s"} against SurveySparrow`,
      });

      const readiness = await ensureSurveyVariablesExist({
        region: ss.region,
        apiKey: ss.apiKey,
        surveyId,
        variables: draftCustomVariables,
        signal: ctrl.signal,
        onProgress: (event) => {
          if (event.kind === "creating") {
            setPushPhase("creating_variables");
            setVariableStats({
              existing: 0,
              created: 0,
              failedNames: [],
            });
          }
        },
      });

      setVariableStats({
        existing: readiness.existingCount,
        created: readiness.createdCount,
        failedNames: readiness.failedNames,
        errorMessage: readiness.errorMessage,
      });

      if (!readiness.ok) {
        const errLabel = readiness.errorMessage ?? "Variable readiness check failed";
        appendDebugLog({
          time: Date.now(),
          kind: "batch_fail",
          label: `Variable readiness — ${readiness.failedNames.length} failed`,
          detail:
            readiness.failedNames.length > 0
              ? `${errLabel} · names: ${readiness.failedNames.slice(0, 3).join(", ")}${readiness.failedNames.length > 3 ? "…" : ""}`
              : errLabel,
        });
        // Mark every response as failed with the variable error so the
        // user sees specifics in the failed-list, then close out the
        // push without trying to ship batches that would only re-fail.
        for (const response of toPush) {
          recordPushResult(response.id, false, undefined, `Variable not ready: ${errLabel}`);
        }
        finishPush();
        abortRef.current = null;
        return;
      }

      appendDebugLog({
        time: Date.now(),
        kind: "batch_ok",
        label: `Variables ready · ${readiness.existingCount} existing${readiness.createdCount > 0 ? `, ${readiness.createdCount} created` : ""}`,
      });

      // Capture persona-bound variable names so the response-builder
      // strips them from each response's `variables` block. SS rejects
      // responses that try to write to persona-bound variables (it
      // auto-populates them from the contact info).
      excludeVariableNames = readiness.excludeFromPayload ?? [];
      if (excludeVariableNames.length > 0) {
        appendDebugLog({
          time: Date.now(),
          kind: "batch_ok",
          label: `Skipping ${excludeVariableNames.length} persona-bound variable${excludeVariableNames.length === 1 ? "" : "s"} from payload: ${excludeVariableNames.join(", ")}`,
        });
      }

      // Capture DATE-typed variable names so the response-builder
      // reformats those values to MM-DD-YYYY before serialisation.
      // SS's response-batch endpoint accepts ONLY MM-DD-YYYY for DATE
      // Custom Properties — every other format returns the misleading
      // "Custom Property not found" error. Format discovered via SS
      // engineering team + Postman verification 2026-06-01.
      dateVariableNames = readiness.dateVariableNames ?? [];
      if (dateVariableNames.length > 0) {
        appendDebugLog({
          time: Date.now(),
          kind: "batch_ok",
          label: `DATE-typed variables will be sent as MM-DD-YYYY: ${dateVariableNames.join(", ")}`,
        });
      }
    }

    setPushPhase("pushing_responses");
    // ------------------------------------------------------------------

    // Build a question-id → parent-question-id lookup for the push payload.
    // Read fresh from the survey store at push time so we always get the
    // current survey's question metadata, not a stale closure value.
    // Without this map, follow-up types like NPSFeedback would push without
    // a parent reference and SurveySparrow would silently drop the answer
    // (rendering "Not Answered" in the response viewer).
    const surveyQuestions = useSurveyStore.getState().questions.data ?? [];
    const questionParents = new Map<number, number>();
    const questionScales = new Map<number, { min: number; max: number }>();
    // `extractQuestionDisplay` is already exported and uses the same
    // `extractScale` probe internally — its `.scale` field is exactly
    // what we need without exporting the internal helper.
    const { extractQuestionDisplay } = await import("@/lib/surveysparrow/types");
    for (const q of surveyQuestions) {
      if (typeof q.parent_question_id === "number") {
        questionParents.set(q.id, q.parent_question_id);
      }
      // Pull the question's actual numeric scale (if any) so we can
      // clamp rating / opinion-scale / slider answers before push. Only
      // populates when SS surfaces a real min/max — questions without a
      // resolvable scale don't get clamped (response-builder treats
      // them as "unknown scale = trust the value").
      const scale = extractQuestionDisplay(q).scale;
      if (scale) {
        questionScales.set(q.id, scale);
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

      // Collect display-logic filtering stats for THIS batch. The
      // response-builder calls onLogicFiltered once per persona; we
      // accumulate and emit ONE debug-log line per batch so the panel
      // stays readable.
      //
      // (Without this, the user couldn't tell whether display_logic was
      // actually doing anything. Surfacing "Batch 2: skipped 23 answers
      // across 8 personas (avg 2.9)" makes it observable end-to-end.)
      let batchDropped = 0;
      let personasWithDrops = 0;
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
          questionScales,
          questions: surveyQuestions,
          excludeVariableNames,
          dateVariableNames,
          onLogicFiltered: ({ dropped }) => {
            if (dropped > 0) {
              batchDropped += dropped;
              personasWithDrops += 1;
            }
          },
        },
      );

      if (batchDropped > 0) {
        const avg = (batchDropped / personasWithDrops).toFixed(1);
        appendDebugLog({
          time: Date.now(),
          kind: "batch_ok",
          label: `Batch ${batchNum}/${totalBatches} — display_logic skipped ${batchDropped} answer${batchDropped === 1 ? "" : "s"} (${personasWithDrops} of ${batch.length} personas, avg ${avg})`,
        });
      }

      // Surface the variable keys actually being shipped. This is the
      // fastest way to verify the persona-bound filter is doing its job
      // when SS rejects a batch with "Invalid value passed or missing
      // values in payload" — if FIRST_NAME / LAST_NAME / CUSTOMER_EMAIL
      // still appear here, the filter missed them and we know where to
      // dig. Pulled from the FIRST response only (all responses in a
      // batch use the same persona-variable schema).
      const firstResponse = payload.responses[0];
      const variableKeys =
        firstResponse?.variables ? Object.keys(firstResponse.variables) : [];
      appendDebugLog({
        time: Date.now(),
        kind: "batch_start",
        label: `Batch ${batchNum}/${totalBatches} — sending ${batch.length} response${batch.length === 1 ? "" : "s"}`,
        detail: variableKeys.length > 0
          ? `variables: ${variableKeys.join(", ")}`
          : "no variables in payload",
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
        /** Positional failure detail — index in batch + message. */
        failureIndexes?: Array<{ index: number; message: string }>;
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

      // SS reports failures POSITIONALLY — `result.failureIndexes[i].index`
      // is the position in the batch (and in the SS response array) that
      // failed, plus the per-response message. The previous version
      // ignored this and marked the LAST N entries as failed, which
      // misled the UI about which personas needed retrying. Now we map
      // the exact position back to its responseId.
      //
      // Two fallback paths preserved for robustness:
      //   1. If failureIndexes is missing (older route, or unknown shape)
      //      we fall back to "first N succeed, last N fail" — better than
      //      crashing, even if imprecise.
      //   2. If a failure exists but we don't have a message for that
      //      index, use the first failureReason as a generic fallback.
      const fallbackReason = result.failureReasons?.[0] ?? "Failed in batch";
      const failureByIndex = new Map<number, string>();
      if (Array.isArray(result.failureIndexes)) {
        for (const f of result.failureIndexes) {
          failureByIndex.set(f.index, f.message || fallbackReason);
        }
      }
      const hasPositional = failureByIndex.size > 0;

      for (let j = 0; j < batch.length; j++) {
        let isSuccess: boolean;
        let reason: string | undefined;
        if (hasPositional) {
          const failMsg = failureByIndex.get(j);
          isSuccess = failMsg === undefined;
          reason = failMsg;
        } else {
          isSuccess = j < successCount;
          reason = isSuccess ? undefined : fallbackReason;
        }
        recordPushResult(
          batch[j]!.responseId,
          isSuccess,
          undefined,
          reason,
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
