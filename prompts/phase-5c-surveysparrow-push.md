# Phase 5c — SurveySparrow Push (the moment of truth)

> Paste this into a fresh Claude Code session AFTER Phase 5b is complete.
> This phase has unknowns — the SS POST /v3/responses payload is the
> highest-risk part. Plan for a debugging session after the first real
> push attempt.

## Where the project stands

Plumage is an internal SurveySparrow Presales tool. Phases 1–5b are
complete:

- Phase 1: Auth + Setup
- Phase 2: Survey selection + question loading
- Phase 3: Configure wizard
- Phase 4: Persona synthesis (LLM)
- Phase 5a: Response generation (LLM)
- Phase 5b: Polished preview UI + CSV/XLSX export

Your job: take the `GeneratedResponse[]` in the responses-store and push
them to a real SurveySparrow workspace. After this phase Plumage is
**end-to-end functional**.

**Stack:** Next.js 15.5.16 · TypeScript strict · pnpm · Zustand · Tailwind
+ shadcn/ui. No new deps unless you discover SS needs something specific
(e.g. a phone-formatting lib for SS's strict E.164 requirement, but try
without first).

## Architectural patterns to preserve

### 1. Server-side proxy for SS calls

API keys never reach the browser long-term. The Push action triggers a
fetch to `/api/surveysparrow/push-responses` with the responses + region +
SS API key in the request body. The server proxies to the SS API. Same
pattern as `/api/surveysparrow/test-connection/route.ts`.

### 2. SSE for push progress

Same SSE patterns as Phase 5a's `/api/llm/responses` route:
- `installDisconnectSuppressor()` at module load
- `consumerGone` + `safeEnqueue` defensive bits
- Cancel-aware via `req.signal`

### 3. Hand-rolled rate limit + concurrency

Don't pull in `p-limit` or similar. Build a token-bucket throttle inline:
- 25 concurrent requests max
- 10 req/sec ceiling (token bucket: 10 tokens, refill 10/sec)

### 4. Retry with exponential backoff

3 attempts per response with backoff: 1s, 4s, 9s. Continue on individual
failures — never abort the whole batch because one response failed. Track
per-response status: `pushing` → `pushed` | `failed` with `errorMessage`.

### 5. Verbatim upstream errors

Phase 1 established this rule: pass through SS's actual error messages, not
generic ones. SEs debug in front of customers. If SS returns
`"contact_phone must be E.164 formatted"`, the user sees that string, not
"push failed".

## SurveySparrow API references

Read these before writing the response-builder:

1. **`prompts/phase-5-response-payload-samples.md`** — the canonical
   response payload spec. Per-type answer shapes, sub-question rules,
   metadata fields, mandatory `region_code` / `time_zone` / date format
   handling, and the field-mapping table for translating Plumage's persona
   data to the SS wire format. **This is the source of truth for the
   response-builder.**

2. **`prompts/phase-5-question-payload-samples.md`** — question definition
   payloads. Useful for understanding how question types are *configured*
   on SS (rating_scale, scale_points, matrix subtypes, ContactForm row
   types). The response payloads reference IDs that come from these
   definitions.

3. **`POST /v3/variables/batch`** —
   https://developers.surveysparrow.com/rest-apis/post-v-3-variables-batch

   Used to ensure custom variables exist in the workspace before pushing.
   SS returns the existing variable on duplicate `api_identifier`, so
   handle that gracefully (don't treat it as an error).

   Note: the response payload's `variables` object is keyed by
   `api_identifier`, not by SS variable ID — but we still pre-create
   variables to make sure they show up in the SS dashboard's column list.

4. **Region routing** — `lib/surveysparrow/regions.ts` maps region codes to
   base URLs. The Push route reads region from the setup-store (passed in
   body) and picks the correct base URL. Mirror
   `app/api/surveysparrow/test-connection/route.ts`.

### Verification one-shot before bulk push

After implementing the builder, push **ONE** response first against the
user's Nexora workspace. Inspect it in SS. Adjust the builder if anything
is wrong. Only then push 20, then 100. The unknowns flagged in the
payload reference doc (region_code on ContactForm phone, browser_language
format, channel_id requirement) need real-API confirmation.

## Deliverables

### 1. `lib/surveysparrow/response-builder.ts` — payload mapper

```ts
export interface BuildResponsePayloadInput {
  response: GeneratedResponse;
  persona: Persona;
  questions: Question[];               // raw SS questions (need properties.data for date_format etc.)
  customVariables: CustomVariable[];
  surveyId: number;
  systemMetadata: SystemMetadataConfig;
}

export function buildSurveySparrowResponsePayload(
  input: BuildResponsePayloadInput,
): Record<string, unknown>;
```

The wire shape is fully spec'd in
`prompts/phase-5-response-payload-samples.md`. Implementation rules:

**Top level:**
- `survey_id`
- `trigger_workflow: false` (always — demo data must not fire automation)
- `variables`: `persona.variableValues` (object keyed by `apiIdentifier`,
  values are string/number)
- `meta_data`: build from `persona` + `systemMetadata`. Only emit the
  9 official fields, only when `systemMetadata.X.enabled === true`:
  - `os`, `browser`, `time_zone`, `browser_language` (e.g. `"en-US"` —
    derive from `persona.language` + `persona.country`),
  - `device_type` UPPERCASE: `"COMPUTER"` / `"MOBILE"` / `"TABLET"` (map
    from `persona.deviceType`)
  - `date_time`: `persona.submittedAt` (ISO 8601)
  - `tags`: `systemMetadata.tags.values`
  - `ip`: `persona.ipAddress` (omit field entirely if null)
  - `language`: language **display name** from `LANGUAGES_BY_CODE`
- `answers`: flat array (see below)

**Answers array — flatten internal AnswerValue → wire format:**

For each `(questionId, answerValue)` in `response.answers`, look up the
question by `id`. Then by `answerValue.type`:

| Internal type | Wire format |
|---|---|
| `text` | `{ question_id, answer: value }` |
| `nps` / `csat` / `ces` / `rating` / `opinion_scale` / `slider` | `{ question_id, answer: value }` (numeric) |
| `single_choice` / `dropdown` | `{ question_id, answer: [choiceId] }` |
| `multi_choice` | `{ question_id, answer: [...choices.map(c => c.id)] }` |
| `yes_no` | `{ question_id, answer: value ? "Yes" : "No" }` (use custom labels from `properties.data.yes_text`/`no_text` if present) |
| `number` | `{ question_id, answer: value }` |
| `email` | `{ question_id, answer: value }` |
| `url` | `{ question_id, answer: value }` |
| `phone` | `{ question_id, answer: value, region_code: persona.country }` |
| `date` | `{ question_id, answer: formatDate(value, question.properties.data.date_format ?? "DDMMYYYY"), time_zone: persona.timezone }` |
| `ranking` | `{ question_id, answer: orderedChoiceIds }` |
| `matrix_single` | for each `[rowId, scalePointId]` → `{ question_id: rowId, parent_question_id: questionId, answer: [scalePointId] }` |
| `matrix_multiple` | for each `[rowId, scalePointIds[]]` → `{ question_id: rowId, parent_question_id: questionId, answer: scalePointIds }` |
| `matrix_dropdown` | for each `[rowId, choiceId]` → `{ question_id: rowId, parent_question_id: questionId, answer: [choiceId] }` |
| `matrix_text` | for each `[rowId, [{columnId, text}, …]]` → `{ question_id: rowId, parent_question_id: questionId, answer: [columnIds…], matrix_txt: [texts…] }` |
| `matrix_rating` | for each `[rowId, [{columnId, value}, …]]` → `{ question_id: rowId, parent_question_id: questionId, answer: [columnIds…], matrix_int: [values…] }` |
| `group_rating` | for each `[rowId, value]` → `{ question_id: rowId, parent_question_id: questionId, answer: value }` |
| `constant_sum` | for each `[rowId, value]` → `{ question_id: rowId, parent_question_id: questionId, answer: value }` |

**ContactForm:** non-answerable in Plumage's registry — the LLM doesn't
generate. The builder fills sub-fields from `persona` data per the table
in the payload reference doc. Each sub-field becomes its own answer
object with `parent_question_id` pointing to the ContactForm question's
ID. Inspect each row's `row_type` in `question.row` to pick the right
fill rule (string from name, email from persona.email, etc.).

**Rules to enforce:**
- `question_id` must be unique across the flat answers array (409
  otherwise). Sub-questions have their own unique IDs — that's fine.
- Skip non-answerable questions (welcome screens, file uploads, etc.)
  but DO emit ContactForm sub-fields filled from persona.
- Date format conversion: `"YYYY-MM-DDTHH:mm:ss.sssZ"` → format per
  question's `date_format` config in the persona's timezone.

Add a small dev-time sanity check that rejects builders producing duplicate
question IDs — `console.assert` is fine, no test framework.

### 2. `app/api/surveysparrow/variables/route.ts` — variable upsert

```
POST /api/surveysparrow/variables
Body: { region, apiKey, variables: CustomVariable[] }
Response: { ok: true, idsByApiIdentifier: Record<string, number> }
        | { ok: false, error: string }
```

Calls `POST /v3/variables/batch` against the SS region's base URL. Maps
each `CustomVariable` to SS's expected shape (research the endpoint —
likely `{ name, api_identifier, type, default_value? }`). Returns the IDs.

If a variable already exists, SS returns the existing one — accept that
and use the returned ID. Do NOT error on duplicates.

This is a **regular JSON route** (not SSE) — variable creation is fast
and one-shot.

### 3. `app/api/surveysparrow/push-responses/route.ts` — SSE push endpoint

```
POST /api/surveysparrow/push-responses
Body: {
  region, apiKey,
  surveyId,
  responses: GeneratedResponse[],
  personas: Persona[],
  questions: QuestionDisplay[],
  customVariables: CustomVariable[],
  variableIdsByApiIdentifier: Record<string, number>,
  systemMetadata: SystemMetadataConfig,
}
```

SSE events:
- `{ type: "start", total }`
- `{ type: "push_progress", pushed, failed, total }` — emit on each
  completion
- `{ type: "response_pushed", responseId, surveysparrowResponseId }`
- `{ type: "response_failed", responseId, message }`
- `{ type: "complete", successCount, failureCount, pushedIds: string[],
   failures: Array<{ responseId, message }> }`
- `{ type: "error", message }` — for fatal errors (auth, rate limit
  exhausted, etc.)

Implementation:
- Token bucket: max 10 tokens, refill 10/sec
- Bounded pool: max 25 concurrent in-flight
- Per-response: `buildSurveySparrowResponsePayload` → fetch SS → on
  failure, classify error → retry up to 3 times with backoff → record
  outcome
- On `429 Too Many Requests`: respect `Retry-After` header before
  retrying. Don't burn retry attempts on rate limits — separate retry
  budget for rate-limit retries (up to 5 with the backoff dictated by
  `Retry-After`).

`installDisconnectSuppressor()` at module load. `runtime = "nodejs"`,
`maxDuration = 300`.

### 4. `lib/generation/sse-push-client.ts` — browser consumer

Mirror `lib/generation/sse-responses-client.ts`. Type the event union as
the push events above.

### 5. `store/responses-store.ts` — extend for push state

Add to the store (don't replace existing fields):

```ts
pushStatus: "idle" | "preparing_variables" | "pushing" | "complete" | "failed" | "cancelled";
pushProgress: { pushed: number; failed: number; total: number };
pushedIds: string[];                                // SS response IDs
failures: Array<{ responseId: string; personaName: string; message: string }>;
variableIdsByApiIdentifier: Record<string, number>;

beginPush(total): void;
recordPushed(responseId, surveysparrowResponseId): void;
recordFailed(responseId, message): void;
finishPush(...): void;
abortPush(): void;
```

Per-response status updates the existing `responses[].status` /
`pushedResponseId` / `errorMessage` fields. Persist push state to
sessionStorage (no creds).

### 6. UI: complete the State A → D → E flow

#### State A (PreGenerationCard) — wire the "Skip preview" toggle

Already rendered as a placeholder in 5a. Now make it functional:
- Default: OFF
- Tooltip: "Skip preview and push directly to SurveySparrow. Use only when
  you're confident in the configuration."
- When ON: pre-generation → generation → push (skip State C entirely)
- When OFF: pre-generation → generation → State C → user clicks Push →
  State D → State E

Use a Zustand-managed boolean rather than local state — the component
swaps cards based on it.

#### Push action in State C

The "Push to SurveySparrow" button in `PreviewCard.tsx` (5b) currently
shows a "ships in 5c" toast. Now wire it:
- Disabled while push is in progress
- Show a confirm dialog if `responses.length > 1000` ("This will push N
  responses. Continue?")
- Triggers the variable-creation call, then transitions to State D

#### State D — `PushingCard.tsx`

```
┌──────────────────────────────────────────────┐
│ Pushing to SurveySparrow…                    │
│                                              │
│ ████████░░░░░░░░  47 / 100                   │
│                                              │
│ Pushed: 45    Failed: 2    Remaining: 53     │
│ ~1 min remaining                             │
│                                              │
│ [Cancel]                                     │
└──────────────────────────────────────────────┘
```

Cancel button aborts the SSE stream (same useRef AbortController pattern).
Cancellation is "stop new pushes" — in-flight requests complete
(SurveySparrow doesn't support mid-flight abort cleanly).

#### State E — `CompleteCard.tsx`

```
┌──────────────────────────────────────────────┐
│ ✓ 98 responses pushed to SurveySparrow       │
│   2 responses failed (see details below)     │
│                                              │
│ Survey: Installation Experience Feedback     │
│ Workspace: experience.nexoraliving.cc        │
│ Tags applied: plumage-2026-05                │
│                                              │
│ [📥 Download responses (CSV/XLSX)]            │
│ [📋 View in SurveySparrow]                    │
│ [♻️ Generate another batch]                    │
│ [🗑️ Bulk delete these responses]              │
└──────────────────────────────────────────────┘
```

Buttons:
- **Download** — same CSV/XLSX export from 5b
- **View in SurveySparrow** — opens
  `https://{workspace}.surveysparrow.com/dashboard/cx/surveys/{surveyId}/reports`
  in a new tab. Workspace domain comes from where? Either:
  - Ask user to enter it during setup (one-time, save to setup-store —
    NOT api key, just the domain), OR
  - Skip the button if we don't have it
- **Generate another batch** — resets State E → State A, clears responses
  store
- **Bulk delete** — calls a new endpoint to delete by tag (preferred) or
  by stored response IDs (fallback). See "Bulk delete" below.

If `failures.length > 0`, show an expandable "Failure details" section
with a table: persona name, error message, "Retry" button per row.
Retry triggers a single-response push.

### 7. Bulk delete

`app/api/surveysparrow/delete-responses/route.ts`:
- POST `{ region, apiKey, surveyId, mode: "tag" | "ids", tag?: string,
  ids?: string[] }`
- Tag mode (preferred): use SS's `DELETE /v3/responses?tags=plumage-2026-05`
  if it exists; else GET responses by tag → delete each
- IDs mode: iterate and `DELETE /v3/responses/{id}`
- Return `{ ok, deletedCount, errors }`

This is the foundation for Phase 6 (history/cleanup) — store the tag and
response IDs in IndexedDB at push completion so a future History page can
list past generations and cleanup them.

For 5c, the in-place "Bulk delete" button uses the IDs from the most
recent push. Show a confirm dialog before deleting. Don't call this
"undo" — pushed responses can't truly be undone, but immediate delete is
the closest approximation.

### 8. Persist push history (groundwork for Phase 6)

Add `lib/storage/push-history.ts` (IndexedDB-backed):

```ts
interface PushRecord {
  id: string;                    // uuid
  pushedAt: number;
  region: string;
  surveyId: number;
  surveyName: string;
  workspace?: string;
  responseCount: number;
  successCount: number;
  failureCount: number;
  tags: string[];
  pushedResponseIds: string[];   // SS response IDs for cleanup
  // No API keys, ever.
}
```

Save a record on push completion. Phase 6 will surface these.

## Smoke gates

```
pnpm typecheck   → clean
pnpm lint        → clean
pnpm build       → compiles
```

## Verification (real workspace, end-to-end)

This is non-negotiable. Don't move past 5c until all 9 steps work:

1. Configure: 20 personas, English-only, simple survey (NPS + 2 open-text +
   1 multi-choice), default models
2. Synthesize personas (Phase 4) — verify quality
3. Generate responses (Phase 5a) — verify quality in preview
4. Click Push to SurveySparrow → confirm dialog → State D → State E
5. Open SS dashboard → confirm 20 responses appear in the survey's
   responses list
6. Filter by tag `plumage-2026-XX` in SS → all 20 found
7. Open one response in SS → verify all answers are present and correct
   (NPS value, open-text content, multi-choice selection, etc.)
8. Click "Bulk delete these responses" in Plumage → confirm → State E
   updates to "Deleted N responses"
9. Re-check SS dashboard → 20 responses gone

If any step fails, debug and fix BEFORE declaring 5c done. Common failure
modes to watch for:
- Wrong field names in the SS payload (the response-builder will need
  iteration based on real SS responses)
- Phone format rejection — SS may require E.164
- Date format rejection — SS may want ISO 8601 with timezone
- Custom variable type mismatch — STRING/NUMBER/DATE alignment with SS's
  type enum
- Choice ID mismatch — confirm the IDs in `extractQuestionDisplay` match
  the IDs SS expects on POST

## Out of scope for 5c

- Multi-survey simultaneous push — single survey only
- Response editing in the preview before push — out of scope
- Webhook simulation — never, that's a different product
- History page (`/history` route) — Phase 6, but groundwork (push-history
  storage) lands here

## File checklist

- [ ] `lib/surveysparrow/response-builder.ts`
- [ ] `app/api/surveysparrow/variables/route.ts`
- [ ] `app/api/surveysparrow/push-responses/route.ts`
- [ ] `app/api/surveysparrow/delete-responses/route.ts`
- [ ] `lib/generation/sse-push-client.ts`
- [ ] `store/responses-store.ts` — extend with push state
- [ ] `lib/storage/push-history.ts`
- [ ] `components/generate/generate/PushingCard.tsx`
- [ ] `components/generate/generate/CompleteCard.tsx`
- [ ] `components/generate/generate/PreGenerationCard.tsx` — wire skip-
      preview toggle
- [ ] `components/generate/generate/PreviewCard.tsx` — wire push button
- [ ] `components/generate/generate/GenerateAndPushStep.tsx` — wire
      States D + E
- [ ] `components/shared/LogoutButton.tsx` — clear push history? **No —
      push history is non-secret and useful across sessions. Keep.**

## Reference files

- `app/api/surveysparrow/test-connection/route.ts` — region routing pattern
- `app/api/surveysparrow/surveys/route.ts` — paginated SS call pattern
- `lib/surveysparrow/regions.ts` — region → base URL
- `app/api/llm/responses/route.ts` (5a) — SSE route template
- `lib/generation/sse-responses-client.ts` (5a) — browser SSE consumer
  template
- `components/generate/generate/GeneratingCard.tsx` (5a) — progress card
  template

## Strategic note

This phase will reveal payload-format surprises. The response-builder
function will need iteration after the first real push attempt. Plan for
2 sub-sessions:

1. **Build everything assuming a reasonable payload shape, then push 5
   responses.** Inspect SS's response. If it accepted them: great. If it
   rejected them: read the error verbatim, adjust response-builder, repeat.
2. **Once 5 responses succeed, push 100 to verify rate-limiting + retry
   logic.** Cancel mid-push to verify the abort path. Force a failure
   (invalid choice ID) to verify the retry → fallback path.

Don't ship without the 9-step end-to-end verification passing on a real
workspace. This is the moment of truth for the entire build.
