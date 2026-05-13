# Phase 5a — Response Generation (LLM)

> Paste this into a fresh Claude Code session. Read the whole prompt before
> writing any code. The response prompt template (item 1 in deliverables) is
> the single highest-leverage file in the codebase — get it right.

## Where the project stands

You're continuing **Plumage** — an internal SurveySparrow Presales tool that
generates demo survey responses. Phases 1–4 are complete:

- Phase 1: Auth + Setup (region picker, SS API test, LLM provider toggle)
- Phase 2: Survey selection + question loading
- Phase 3: Configure wizard (context, themes, persona distribution, languages,
  custom variables, system metadata, timing, live cost estimator)
- Phase 4: Persona Synthesis — `synthesizePersonas()` produces an array of
  `Persona` objects, each with deterministic Faker-generated identity/geo/
  device fields plus LLM-generated personality (sentiment, keyConcerns,
  themesTouched, verbosity, demographicNotes)

Phase 4 quality is verified with real workspace runs. Persona distribution
holds, languages map correctly, geography is coherent, key concerns are
specific to the use case. Greenlit for Phase 5.

**Stack:** Next.js 15.5.16 (App Router) · TypeScript strict · pnpm · Zustand
(no `persist` — credentials in-memory only) · Tailwind + shadcn/ui · raw
fetch (no SDKs) · hand-rolled validators (no Zod) · IndexedDB for non-secret
storage · sessionStorage for personas (no creds) · SSE via fetch +
ReadableStream (NOT EventSource — POST + body needed).

## The two-phase architecture (cornerstone)

This phase is **Phase 2** of the two-phase generation model. Phase 1 (persona
synthesis, already shipped) generates personas in batches of 50 with one
small LLM call per batch covering only personality fields.

**Phase 2 — your job:** for each persona, ONE LLM call generates ALL their
answers to ALL questions in the survey. This guarantees per-respondent
coherence: a Promoter who rates NPS 9 won't write a complaint, a Detractor
who rates 2/5 won't pick "Highly satisfied" on a multi-choice.

NEVER generate per-question. ALWAYS per-persona.

## Architectural patterns you MUST preserve

These came out of bug fixes in earlier phases. Don't re-derive them.

### 1. AbortController must live above the card-swap boundary

The Phase 4 "instant cancel" bug was caused by `useSynthesize` being called
independently inside each child card (`PreSynthesisCard`, `RunningCard`,
`CompletedCard`). When the JSX swapped cards on state change, the unmounting
card's cleanup `useEffect` aborted its own AbortController, killing the run.

**Fix that must carry forward:** call your `useGenerate` hook **once** in the
parent step component (`GenerateStep`) and pass the hook state down as a
prop to children. See `components/generate/synthesize/SynthesizeStep.tsx`
for the canonical pattern.

The `useRef<AbortController | null>(null)` pattern is correct — but only if
the hook owning it doesn't unmount when child cards swap.

### 2. Disconnect suppressor on the SSE route

undici emits `ECONNRESET`, lowercase `"aborted"`, and
`ERR_STREAM_PREMATURE_CLOSE` async after a client-cancelled fetch — outside
any user-space try/catch. Without `installDisconnectSuppressor()` from
`lib/server/disconnect-suppressor.ts`, the dev server crashes on every
Cancel click. Phase 4's personas route imports it once at module load:

```ts
import { installDisconnectSuppressor } from "@/lib/server/disconnect-suppressor";
installDisconnectSuppressor();
```

Your new `/api/llm/responses` route MUST do the same.

### 3. Server-side SSE defensive patterns

Mirror these from `app/api/llm/personas/route.ts`:
- `consumerGone` flag set from BOTH `req.signal.abort` listener AND the
  `ReadableStream.cancel()` callback
- `safeEnqueue()` wrapper that swallows post-disconnect throws and flips
  `consumerGone` to true if the controller errors
- `controller.close()` only when `!consumerGone`, also try/caught
- Early-return for already-aborted requests at route entry

### 4. composeSignal on every LLM call

`lib/llm/json-call.ts` exposes `callLLMForJson()` which already composes the
caller-provided signal with a per-call timeout via a leak-aware
`composeSignal` helper (WeakMap-tracked listener cleanup). USE IT — don't
write your own fetch in the response generator.

### 5. Validator philosophy

Mirror `lib/llm/persona-validator.ts`:
- Hand-rolled, returning **field-level** errors (not just "invalid")
- A `summarizeValidationErrors()` helper that produces a short human string
  fed back into the retry prompt
- "Minimums match the config, not the schema" — e.g. don't reject empty
  `themesTouched` if no themes were configured. For your validator: an open-
  text answer of empty string is invalid only if the question is required.

### 6. Pre-assigned values are authoritative

Phase 4's validator overwrites the LLM's `sentimentArchetype` field with the
pre-assigned value to keep the distribution exact even if the model drifts.
Apply the same principle: if the persona's sentiment dictates an NPS range
(promoter 9–10, passive 7–8, detractor 0–6), enforce that range in the
validator — don't trust the LLM to honor the prompt rule.

## Stepper update

The wizard currently has **5 steps** (`store/wizard-store.ts`):
1. Select survey
2. Configure
3. Synthesize personas
4. Preview (stub)
5. Generate & push (stub)

Phase 5 collapses old steps 4+5 into a single screen. After this phase the
wizard is **4 steps**:
1. Select survey
2. Configure
3. Synthesize personas
4. **Generate & Push** (single screen, multiple internal states)

Update `wizard-store.ts` accordingly: `WizardStep = 1 | 2 | 3 | 4` and adjust
comments. Update `components/generate/StepNav.tsx` to render 4 steps.

For 5a specifically, step 4 has these internal states:

```
Step 4 = Generate & Push (single screen, multi-state)
├── State A: Pre-generation summary  ← 5a builds
├── State B: Generating responses    ← 5a builds
├── State C: Basic preview            ← 5a builds (minimal version)
├── State D: Pushing                  ← 5c builds
└── State E: Complete                 ← 5c builds
```

5b later replaces State C's basic preview with a polished preview + export.
For 5a, build State C as a **functional** preview: a table with one row per
generated response showing persona name + sentiment + language, and a
clickable row that expands to a `<pre>{JSON.stringify(answers, null, 2)}</pre>`
dump. Good enough to verify the prompt is producing the right shape. Polish
comes in 5b.

The "Skip preview, push directly" toggle on State A is wired in **5c**, not
5a. For 5a, the post-generation flow always lands on State C.

## Deliverables

### 1. `lib/generation/response-types.ts` — the schema

Mirror `lib/generation/persona-types.ts`. The internal `AnswerValue` union
is **LLM-friendly** — single-select choices are scalar IDs, sub-question
groups are `Record<rowId, …>`. The 5c builder transforms these into the
SS-required wire format (arrays-of-one for single-select choices, expanded
sub-question objects with `parent_question_id`, etc.). Don't pre-flatten
in the internal type — keeping it ergonomic for the validator and for the
5b preview UI matters more than mirroring the wire format.

```ts
export type AnswerValue =
  | { type: "text"; value: string }
  | { type: "rating"; value: number; scale: { min: number; max: number } }
  | { type: "nps"; value: number }              // 0–10 integer
  | { type: "csat"; value: number }             // 1–5 integer
  | { type: "ces"; value: number }              // 1–7 integer
  | { type: "opinion_scale"; value: number; scale: { min: number; max: number } }
  | { type: "single_choice"; choiceId: number; choiceLabel: string }
  | { type: "multi_choice"; choices: Array<{ id: number; label: string }> }
  | { type: "dropdown"; choiceId: number; choiceLabel: string }
  | { type: "yes_no"; value: boolean }          // builder maps to "Yes"/"No"
  // Matrix variants — `subType` lets the builder pick the right wire shape.
  // Single/Multiple/Dropdown all use scale-point or choice IDs per row.
  | { type: "matrix_single"; rows: Record<string, number> }                 // rowId → scalePointId
  | { type: "matrix_multiple"; rows: Record<string, number[]> }             // rowId → [scalePointId]
  | { type: "matrix_dropdown"; rows: Record<string, number> }               // rowId → choiceId
  | { type: "matrix_text"; rows: Record<string, Array<{ columnId: number; text: string }>> }
  | { type: "matrix_rating"; rows: Record<string, Array<{ columnId: number; value: number }>> }
  // GroupRating: per-row numeric (each row is a separate sub-question on SS)
  | { type: "group_rating"; rows: Record<string, number> }
  // ConstantSum: per-row numeric, sum should equal totalSum
  | { type: "constant_sum"; rows: Record<string, number>; totalSum: number }
  // Ranking: ordered IDs
  | { type: "ranking"; orderedChoiceIds: number[] }
  // Slider: numeric (LLM treats like rating)
  | { type: "slider"; value: number; scale: { min: number; max: number } }
  // Free-form scalars
  | { type: "number"; value: number }
  | { type: "date"; value: string }             // internal: ISO 8601 — builder reformats per question's date_format
  | { type: "url"; value: string }
  | { type: "email"; value: string }
  | { type: "phone"; value: string };

export interface GeneratedResponse {
  id: string;                          // plumage uuid
  personaId: string;                   // links to Persona.id
  personaName: string;                 // denormalized for display
  answers: Record<string, AnswerValue>; // keyed by SS question id (stringified)
  // Status tracking — `pushedResponseId` and "pushing"/"pushed"/"failed"
  // are set in 5c. For 5a, status starts and stays at "generated".
  status: "generated" | "pushing" | "pushed" | "failed";
  pushedResponseId?: string;
  errorMessage?: string;
  generatedAt: number;                  // Date.now() at completion
}

export type GenerateResponsesEvent =
  | { type: "start"; total: number }
  | { type: "progress"; completed: number; total: number; latestPersonaName: string }
  | { type: "persona_warning"; personaId: string; personaName: string; message: string }
  | { type: "complete"; responses: GeneratedResponse[] }
  | { type: "error"; message: string };
```

Notes:
- Identity/geography/device/timing/variables data lives on the `Persona` —
  don't duplicate it on `GeneratedResponse`. The 5c push builder reads both.
- Choice/scale-point IDs are **numbers** (SS surfaces them as numbers in
  `extractQuestionDisplay()`). Don't stringify.
- Matrix variants are split because the validator and the builder need to
  know which wire shape to produce. Read
  `prompts/phase-5-response-payload-samples.md` (Matrix section) — each
  variant uses a different combination of `answer` / `matrix_txt` /
  `matrix_int`. The validator must look at the question's
  `properties.data.type` (`SINGLE_ANSWER` / `MULTIPLE_ANSWER` / `DROP_DOWN`
  / `TEXT_INPUT` / `RATING`) to pick the expected internal `AnswerValue`
  variant.
- `group_rating` and `constant_sum` look like one logical answer to the LLM
  but expand to multiple sub-question entries in the SS payload (each row
  becomes its own answer with `parent_question_id`). Keeping them grouped
  internally makes the prompt cleaner — flattening happens only in 5c's
  builder.
- ContactForm is non-answerable in `lib/surveysparrow/question-types.ts`
  (`bucket: "contact"`, `answerable: false`) — the LLM does NOT generate
  for it. 5c's builder fills sub-fields from persona contact data.
- Add a `summarizeResponses()` helper analogous to `summarizePersonas()`:
  avg NPS, avg CSAT, sentiment-bucket counts, etc. 5b uses this for the
  stats bar; 5a's basic preview can use it too.

### 2. `lib/llm/prompts/response-prompt.ts` — THE prompt

This is the highest-leverage file in the project. Read
`lib/llm/prompts/persona-prompt.ts` for tone and structure.

**System prompt — required content:**
```
You are simulating a survey respondent. You will be given a persona profile (a
simulated customer) and a survey, and you must produce ALL of that person's
answers to ALL questions in one response.

CRITICAL RULES:
1. Stay in character as the persona for the ENTIRE response. Same person, same
   opinions, same vocabulary, same emotional state across all questions.
2. Maintain internal coherence: a Promoter who rates NPS 9 should not write a
   complaining open-text answer. A Detractor who rates 2/5 should not select
   "Highly satisfied" on a multiple choice.
3. Match the persona's verbosity:
   - terse: 1 short sentence for open-text, no fluff
   - medium: 2-3 sentences, natural conversational tone
   - verbose: 3-5 sentences, more detail and emotion
4. Reference the persona's specific keyConcerns and themesTouched in their
   open-text answers. Don't generate generic feedback — generate THIS person's
   feedback.
5. Write open-text answers in the persona's assigned language. NOT translated
   from English — written natively. Casual register, not textbook.
6. Vary writing style realistically: not every persona writes perfect grammar.
   Casual personas may have minor typos, run-on sentences, or informal
   phrasing. Match it to the demographic notes.
7. NEVER break character to explain what you're doing. Your output is the
   persona's answers, nothing else.
8. For choice/dropdown/multi-choice questions, return the choice ID (number),
   never the label as a string. The schema enforces this.

OUTPUT: Strict JSON matching the provided schema. No prose, no explanation,
no markdown wrapping.
```

**User prompt — render this for each persona individually:**
- Persona block: name, language, country, city, sentiment, verbosity,
  keyConcerns (bullets), themesTouched (bullets), demographicNotes
- Survey block: name, optional description, useCase context
- Questions block: render each answerable question with its ID, position,
  text (already HTML-stripped via `extractQuestionDisplay`), type, and
  type-specific constraints:
  - **Rating / OpinionScale / Slider:** scale min/max, optional min/max labels
  - **NPS:** "Scale 0–10 (0=Not at all likely, 10=Extremely likely)"
  - **CSAT:** "Scale 1–5"
  - **CES:** "Scale 1–7"
  - **MultiChoice / Dropdown:** list each choice with `id` and `label`. For
    multi-select MultiChoice, note "select 1+ options". For single-select,
    "select exactly one".
  - **YesNo:** "answer with true (yes) or false (no)"
  - **Matrix:** list rows with id+label, then columns with id+label. Note
    the matrix subtype (single/multiple/dropdown/text/rating) and what the
    expected per-row answer is. Render as one logical question to the LLM
    even though it expands to multiple sub-questions on the wire.
  - **GroupRating:** list rows (statements) with id+label and the rating
    scale. LLM produces per-row numeric ratings.
  - **ConstantSum:** list rows with id+label and the `total_sum` constraint.
    LLM produces per-row integers that sum to total.
  - **RankOrder:** list choices, note "rank by ordering choice IDs (first =
    highest rank)"
  - **PhoneNumber:** the persona has `persona.phone` already — but if the
    LLM is generating a phone for a non-contact phone question, instruct
    E.164 format with country code matching `persona.country`.
  - **DateTime:** ask for ISO 8601. The builder will reformat per the
    question's `date_format` in 5c.
  - **Required** flag if `required: true`
- Sentiment alignment instructions:
  - promoter: NPS 9–10, CSAT 4–5, ratings near top of scale
  - passive: NPS 7–8, CSAT 3, mid-scale
  - detractor: NPS 0–6, CSAT 1–2, low-scale
- Output schema with concrete examples for each type, e.g.:
  ```
  {
    "answers": {
      "12345": { "type": "nps", "value": 9 },
      "12346": { "type": "text", "value": "El equipo fue muy amable..." },
      "12347": { "type": "single_choice", "choiceId": 88 }
    }
  }
  ```

**Non-answerable types** (`bucket: screen | file | voice | video | contact`
in `lib/surveysparrow/question-types.ts`): exclude from the prompt entirely.
Do not even mention them in the question list.

**Choice IDs:** the prompt must instruct the model to return the numeric ID
only — `choiceLabel` is denormalized AFTER the LLM call by the validator
(looking it up from the question's choices). This avoids the LLM mangling
labels.

**Retry block:** if `retryReason` is provided (validation failure on
previous attempt), append it at the end of the user prompt, just like
`buildPersonaPrompt`.

Export the same three things as the persona prompt:
```ts
export function buildResponsePrompt(input: {
  persona: Persona;
  questions: QuestionDisplay[];
  surveyContext: SurveyContext;
  retryReason?: string;
}): { systemPrompt: string; userPrompt: string };
```

### 3. `lib/llm/response-validator.ts` — hand-rolled validation

Per-question-type rules:
- Every answerable question's id must appear as a key in `answers`. Missing
  required questions = error. Missing non-required questions = warning that
  triggers retry on first attempt only.
- `text`: non-empty string, min 5 chars, max 2000.
- `nps`: integer 0–10. Promoter persona must be ≥9, passive 7–8, detractor 0–6.
- `csat`: integer 1–5. Promoter ≥4, passive =3, detractor ≤2.
- `ces`: integer 1–7.
- `rating` / `opinion_scale` / `slider`: integer within `scale.min`/`scale.max`
  (use the question's `extractQuestionDisplay()` scale).
- `single_choice` / `dropdown`: `choiceId` must match a real choice on the
  question. Look up the matching choice and **set** `choiceLabel` from the
  question (denormalize, don't trust LLM).
- `multi_choice`: array of valid choice IDs. Length ≥ 1. Denormalize labels
  from the question.
- `yes_no`: boolean.
- `matrix_single` / `matrix_dropdown`: every required row has an entry,
  value is a valid scale-point/choice ID for that question.
- `matrix_multiple`: every required row has an array of ≥1 valid IDs.
- `matrix_text`: every required row has at least one
  `{columnId, text}` entry; text is a non-empty string.
- `matrix_rating`: every required row has at least one
  `{columnId, value}` entry; value is within the question's rating scale.
- `group_rating`: every required row has a numeric value within the rating
  scale.
- `constant_sum`: every required row has an integer; the sum across rows
  equals `totalSum` (read from `properties.data.total_sum`); if range
  limits exist (`minLimit`/`maxLimit`), each row falls within them.
- `ranking`: array contains every choice ID exactly once.
- `number`: integer or float as appropriate.
- `date`: parseable ISO 8601 (the builder reformats for the wire).
- `url` / `email` / `phone`: format-check (lenient — these are demo data).

Return shape:
```ts
{
  ok: true,
  answers: Record<string, AnswerValue>,
  warnings: string[],   // non-fatal corrections (e.g. label remapped)
}
| {
  ok: false,
  errors: ValidationError[],   // field-level
  partialAnswers?: Record<string, AnswerValue>,  // best-effort merge for fallback
}

export function summarizeValidationErrors(errors: ValidationError[]): string;
```

The summarizer should output something like:
> "Question 12345 (NPS) returned value 11 — must be 0–10. Question 12346
> (text) returned empty string. Question 12347 (single_choice) returned
> choiceId 999 which is not a valid option."

### 4. `lib/generation/response-generator.ts` — the orchestrator

Mirror `lib/generation/persona-synthesizer.ts` exactly:

```ts
export interface GenerateResponsesInput {
  personas: Persona[];
  questions: QuestionDisplay[];      // already filtered to answerable ones
  surveyContext: SurveyContext;
  credentials: {
    provider: LLMProvider;
    apiKey: string;
    responseModel: string;
  };
  signal?: AbortSignal;
}

export async function* generateResponses(
  input: GenerateResponsesInput,
): AsyncGenerator<GenerateResponsesEvent, void, void>;
```

Concurrency:
- **8** parallel LLM calls for Anthropic
- **5** parallel LLM calls for OpenAI (tighter rate limits)
- Pick by `credentials.provider` at the top of the function

Retries:
- 2 retries per persona (3 attempts total) on validation failure
- Each retry includes the `summarizeValidationErrors(prev.errors)` in the
  prompt's `retryReason` block
- If all 3 attempts fail: emit `persona_warning` event, fall back to
  `partialAnswers` (filling required answers with sensible defaults — e.g.
  for NPS, the midpoint of the persona's allowed sentiment range).

Use the same async-generator + bounded-concurrency-pool + event-queue +
wake-promise pattern as `synthesizePersonas`. Don't reinvent it. Read that
file and lift the structure verbatim, swapping per-batch logic for
per-persona logic.

Token budget: each response call may request up to **4096 output tokens**
(longer than persona calls because there can be many open-text answers).
Anthropic supports `max_tokens: 4096`; OpenAI's GPT-4o supports it via
`max_tokens`. Already handled by the `maxOutputTokens` field on
`callLLMForJson`.

### 5. `app/api/llm/responses/route.ts` — SSE streaming endpoint

Copy the structure of `app/api/llm/personas/route.ts` exactly. Required:
- `installDisconnectSuppressor()` at module load
- `runtime = "nodejs"`, `maxDuration = 300`
- `consumerGone` flag, `safeEnqueue`, defensive `controller.close()`
- Validate request body (provider, apiKey, responseModel, personas array,
  questions array, surveyContext)
- Wire `req.signal` into `generateResponses()` so client cancel propagates

Body shape:
```ts
{
  personas: Persona[];
  questions: QuestionDisplay[];
  surveyContext: SurveyContext;
  credentials: { provider, apiKey, responseModel };
}
```

Response: `text/event-stream` with `progress`, `persona_warning`, `complete`,
`error` events.

Pre-flight check: if `personas.length * questions.length` would exceed the
model's context window (rough heuristic: >100 questions × ~50 tokens each =
warn at >5000 input tokens per call), reject with a clear error message
suggesting the user split into multiple runs. `lib/llm/models.ts` exposes
the model registry — use it. **Note:** SS surveys will rarely hit this in
practice. A clean error beats a silent context overflow.

### 6. `lib/generation/sse-responses-client.ts` — browser SSE consumer

Copy `lib/generation/sse-client.ts` verbatim, swap event type to
`GenerateResponsesEvent`, point at `/api/llm/responses`. The
`isAbortLike` helper and frame parser carry forward unchanged.

### 7. `store/responses-store.ts` — generated responses state

```ts
interface ResponsesStore {
  status: "idle" | "running" | "complete" | "failed" | "cancelled";
  responses: GeneratedResponse[];
  progress: { completed: number; total: number };
  warnings: Array<{ personaName: string; message: string }>;
  error: string | null;
  latestPersonaName: string;          // for the progress card

  startRun(total: number): void;
  reportProgress(p: { completed: number; total: number; latestPersonaName: string }): void;
  reportPersonaWarning(personaName: string, message: string): void;
  finishRun(responses: GeneratedResponse[]): void;
  failRun(message: string): void;
  abortRun(): void;
  reset(): void;
}
```

Use sessionStorage persistence (same pattern as `personas-store.ts`). NO
credentials. Cleared on sign-out — wire into `LogoutButton.tsx`.

### 8. UI

#### `components/generate/generate/useGenerateResponses.ts`

Mirror `useSynthesize.ts`. Returns:
```ts
{
  start: () => Promise<void>;
  cancel: () => void;
  canStart: boolean;
  reasonNotReady: string | null;
  estimatedSeconds: number | null;
  estimate: CostEstimate | null;
}
```

`reasonNotReady` checks:
- API key present in setup-store
- Personas exist in personas-store with status `complete`
- Questions loaded for the selected survey
- At least one answerable question exists

AbortController in `useRef`. Cleanup on unmount aborts. Same pattern as
Phase 4 — see the Critical Patterns section.

#### `components/generate/generate/GenerateAndPushStep.tsx`

The new step 4 component. **Critical:** call `useGenerateResponses` ONCE at
this top level and pass the hook state down to children. Do NOT call it
inside child cards. (Phase 4 abort bug.)

State machine for 5a:
- `pre` → renders `PreGenerationCard` (State A)
- `running` → renders `GeneratingCard` (State B)
- `complete` → renders `BasicPreviewCard` (State C, basic version)
- `failed` / `cancelled` → renders an error card with retry CTA

Wire to `responses-store` for state transitions.

#### Card components

- **PreGenerationCard:** persona count, survey name, answerable question
  count, provider/model, estimated cost+time, "Generate N responses" CTA.
  The "Skip preview" toggle goes here but is **disabled in 5a** with a
  tooltip ("Available after Phase 5c"). Don't ship it half-wired.
- **GeneratingCard:** progress bar with N / total, latest persona name line
  (rotates as completions come in), warnings counter ("⚠️ N personas
  required retries (recovered)"), Cancel button.
- **BasicPreviewCard (5a version):** stats bar (avg NPS, avg CSAT,
  sentiment counts) + a simple table:

  | # | Avatar | Name | Lang | Country | Sentiment | (expand) |

  Click a row to expand inline showing `<pre>{JSON.stringify(answers, null, 2)}</pre>`.
  No search, no filtering, no XLSX/CSV download — those are 5b. Add a
  "Re-generate" button that resets to `pre` state.

#### Stepper update

`store/wizard-store.ts`: change `WizardStep = 1 | 2 | 3 | 4`, drop step 5
references, update comments.

`components/generate/StepNav.tsx`: render 4 steps with appropriate labels
("Generate"). Lock state for step 4: enabled only when personas-store
status === "complete".

`app/(app)/generate/page.tsx`: route step 4 to `GenerateAndPushStep`.

## Cost estimator update

`lib/generation/cost-estimator.ts` already has Phase 5 token estimates baked
in. Verify the response phase math is sane against your first real run and
adjust the per-persona token estimate constant if needed. Don't rewrite the
estimator.

## Smoke gates (must pass before handoff)

```
pnpm typecheck   → clean
pnpm lint        → clean
pnpm build       → compiles
```

## Verification (manual, on real workspace)

1. Configure: 20 personas, English-only, simple survey (NPS + 2 open-text +
   1 multi-choice is enough), default models.
2. Synthesize personas (Phase 4). Verify quality.
3. Generate responses. Watch progress, verify Cancel works without server
   crash.
4. Inspect 5–10 expanded responses in the basic preview:
   - NPS values match sentiment archetype
   - Open-text references the persona's keyConcerns specifically
   - Multi-choice picks align with sentiment
   - Choice IDs are valid (cross-check against the question's choices)
   - No "as an AI" leakage
5. Repeat with a multilingual config (50% English, 50% Spanish). Verify
   Spanish personas write open-text in Spanish, not English.
6. Save 5–10 sample raw JSON outputs and share back with the user. The
   prompt template will need iteration based on what surfaces here.

## Stop point

After verification step 6, **stop and hand off to the user for prompt
iteration**. The first real run will reveal weaknesses no amount of
prompt-design-in-isolation can fix:
- Maybe non-English answers leak English fragments
- Maybe detractors aren't quite negative enough
- Maybe open-text references generic things instead of specific concerns
- Maybe choice IDs come back as labels despite instructions

The user will share sample outputs with you, you'll iterate the prompt
template, re-run, and verify again. Once the user says "quality is
excellent," 5a is done. Move to 5b in a fresh session.

## Out of scope for 5a (don't build)

- CSV / XLSX export — that's 5b
- Polished preview UI with search, filtering, nicely-rendered answers — 5b
- "Skip preview" toggle wiring — 5c
- Variable creation in SS — 5c
- Push to SurveySparrow — 5c
- Bulk delete — 5c
- History page — Phase 6

## File checklist

- [ ] `lib/generation/response-types.ts`
- [ ] `lib/llm/prompts/response-prompt.ts`
- [ ] `lib/llm/response-validator.ts`
- [ ] `lib/generation/response-generator.ts`
- [ ] `app/api/llm/responses/route.ts`
- [ ] `lib/generation/sse-responses-client.ts`
- [ ] `store/responses-store.ts`
- [ ] `components/generate/generate/useGenerateResponses.ts`
- [ ] `components/generate/generate/GenerateAndPushStep.tsx`
- [ ] `components/generate/generate/PreGenerationCard.tsx`
- [ ] `components/generate/generate/GeneratingCard.tsx`
- [ ] `components/generate/generate/BasicPreviewCard.tsx`
- [ ] `store/wizard-store.ts` — update to 4 steps
- [ ] `components/generate/StepNav.tsx` — update to 4 steps
- [ ] `app/(app)/generate/page.tsx` — wire new step 4
- [ ] `components/shared/LogoutButton.tsx` — clear responses-store

## Reference files (read before coding)

- `lib/generation/persona-synthesizer.ts` — orchestrator pattern
- `lib/llm/json-call.ts` — already has `composeSignal` + retry-friendly
  return shape; use it
- `lib/llm/persona-validator.ts` — validator pattern + retry summarizer
- `lib/llm/prompts/persona-prompt.ts` — prompt structure
- `app/api/llm/personas/route.ts` — SSE route pattern with all defensive
  bits
- `lib/generation/sse-client.ts` — browser SSE consumer
- `lib/server/disconnect-suppressor.ts` — process-level handler
- `components/generate/synthesize/SynthesizeStep.tsx` — three-state UI with
  hook lifted to parent
- `components/generate/synthesize/useSynthesize.ts` — useRef AbortController
  pattern
- `lib/surveysparrow/question-types.ts` — `answerable` flag is the source of
  truth for which questions to include in prompts
- `lib/surveysparrow/types.ts` — `extractQuestionDisplay()` is your
  question-shape interface; choices/scalePoints/scale come pre-normalized

Read those, write the code, smoke test, run end-to-end on a real workspace,
share sample outputs, stop.
