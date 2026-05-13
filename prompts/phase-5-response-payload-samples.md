# SurveySparrow response submission — payload reference

> **Source of truth for Phase 5c.** These are the actual `POST /v3/responses`
> payload shapes verified against SurveySparrow's API docs. Reference this
> file when building `lib/surveysparrow/response-builder.ts`.

## Endpoint surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v3/responses` | Submit a complete response in a single call (Plumage uses this) |
| `POST` | `/v3/responses/new` | Start a partial response (requires partial-submission feature on the survey) |
| `PUT` | `/v3/responses/{response_id}/update` | Add answers to a started response |
| `PUT` | `/v3/responses/{response_id}/complete` | Mark a started response complete |
| `POST` | `/v3/responses/batch` | Create up to 200 responses asynchronously, returns a polling token |
| `GET` | `/v3/responses/status/{token}` | Poll batch import status |

**Plumage's choice:** use `POST /v3/responses` (one call per response). Reasons:
- Simpler error handling — failures are per-response, not "one failed in batch of 200"
- Already concurrency-controlled at our layer (25 in-flight, 10 req/sec)
- Batch endpoint's async pattern adds complexity without speedup at our scale

If we hit rate-limit pain at 1000+ responses, revisit and switch to `/batch`
in a future iteration.

---

## Top-level payload shape

```json
{
  "survey_id": 1,
  "contact_id": 42,
  "channel_id": 3,
  "trigger_workflow": true,
  "variables": {
    "plan_type": "Enterprise",
    "region": "APAC"
  },
  "meta_data": {
    "os": "macOS",
    "browser": "Chrome",
    "time_zone": "Asia/Calcutta",
    "browser_language": "en-GB",
    "date_time": "2024-01-15T10:30:00.000Z",
    "tags": ["tag1", "tag2"],
    "ip": "203.0.113.10",
    "device_type": "COMPUTER",
    "language": "English"
  },
  "answers": [ ... ]
}
```

### Field notes for Plumage

| Field | Source / value |
|---|---|
| `survey_id` | from selected survey |
| `contact_id` | omit — Plumage doesn't use SS contacts |
| `channel_id` | omit unless we add a "share channel" config later |
| `trigger_workflow` | **`false`** — we're injecting demo data, don't fire automation rules |
| `variables` | `persona.variableValues` keyed by `apiIdentifier` (not the SS variable ID — SS resolves by name) |
| `meta_data.os` | `persona.os` |
| `meta_data.browser` | `persona.browser` |
| `meta_data.time_zone` | `persona.timezone` (IANA) |
| `meta_data.browser_language` | language tag, e.g. `en-US` — derive from persona.language + persona.country |
| `meta_data.date_time` | `persona.submittedAt` (ISO 8601) |
| `meta_data.tags` | `systemMetadata.tags.values` |
| `meta_data.ip` | `persona.ipAddress` (omit field if null) |
| `meta_data.device_type` | **uppercase**: `"COMPUTER"`, `"MOBILE"`, `"TABLET"`. Map from `persona.deviceType` (`"Desktop"` → `"COMPUTER"`, `"Mobile"` → `"MOBILE"`, `"Tablet"` → `"TABLET"`) |
| `meta_data.language` | display name, e.g. `"English"`, `"Spanish"` — from `LANGUAGES_BY_CODE[persona.language].name` |

Skip metadata fields where `systemMetadata.X.enabled === false`.

**Contact fields at top level:** the docs show `contact_id`, but for batch
mode there's a `contact: { full_name, email, phone, ... }` object. Plumage
uses `POST /v3/responses` (not batch), so we **don't** include contact at
the top level. Contact info goes into the answers via ContactForm if the
survey has one — see ContactForm section below.

---

## Answer object — common structure

```json
{
  "question_id": 1001,
  "parent_question_id": null,
  "answer": "...",
  "other_txt": "...",
  "matrix_txt": [...],
  "matrix_int": [...],
  "region_code": "IN",
  "time_zone": "Asia/Calcutta",
  "time": "14:30"
}
```

Sub-questions (Matrix rows, GroupRating statements, ConstantSum items,
ContactForm fields) **each get their own answer object** with
`parent_question_id` set to the container question's ID.

**Critical:** duplicate `question_id` entries return `409 Conflict`. Each
question must appear at most once in the `answers` array. Sub-questions are
keyed by their own `question_id`, not the parent's.

---

## Per-type answer formats

### TextInput

```json
{ "question_id": 1001, "answer": "The onboarding experience was smooth." }
```

### EmailInput

```json
{ "question_id": 1002, "answer": "jane.doe@example.com" }
```

### NumberInput / Slider

```json
{ "question_id": 1003, "answer": 42 }
```

### URLInput

```json
{ "question_id": 1004, "answer": "https://www.example.com" }
```

### PhoneNumber

`region_code` (ISO 3166-1 alpha-2) is **required**.

```json
{ "question_id": 1005, "answer": "+919876543210", "region_code": "IN" }
```

Plumage source: `persona.country` (already alpha-2).

### OpinionScale

`answer` is a number between `start` (0 or 1) and `start + step - 1`.

```json
{ "question_id": 1006, "answer": 8 }
```

### Rating

`answer` is 1..rating_scale.

```json
{ "question_id": 1007, "answer": 4 }
```

### YesNo

`answer` is the **string** `"Yes"` or `"No"` (or the question's custom labels).
NOT a boolean.

```json
{ "question_id": 1008, "answer": "Yes" }
```

### Consent

`answer` is a **boolean** (`true` = consented).

```json
{ "question_id": 1009, "answer": true }
```

Note: Consent is non-answerable in Plumage's question-type registry, but if
we ever flip it to answerable we'd default true (a respondent who didn't
consent wouldn't have submitted).

### MultiChoice / Dropdown

`answer` is an **array** of choice IDs, even for single-select. The "Other"
option includes its choice ID in the array and the free text in `other_txt`.

```json
{ "question_id": 1010, "answer": [5001, 5003] }
```

With "Other":
```json
{ "question_id": 1010, "answer": [5001, 5099], "other_txt": "A different option" }
```

Single-select Dropdown:
```json
{ "question_id": 1011, "answer": [5007] }
```

### RankOrder

`answer` is an ordered array of all choice IDs (first = highest rank).

```json
{ "question_id": 1012, "answer": [5003, 5001, 5002, 5004] }
```

### DateTime

`answer` is formatted per the question's configured `date_format` (read from
`question.properties.data.date_format`):

| `date_format` | Format |
|---|---|
| `MMDDYYYY` | `"01/15/2024"` or `"01/15/2024 14:30"` |
| `DDMMYYYY` | `"15/01/2024"` or `"15/01/2024 14:30"` |
| `YYYYMMDD` | `"2024/01/15"` or `"2024/01/15 14:30"` |

`time_zone` (IANA) is **required**. For `DATE_ONLY` types, omit the time.

```json
{ "question_id": 1013, "answer": "15/01/2024 14:30", "time_zone": "Asia/Calcutta" }
```

### Matrix

Each row → its own answer object with `parent_question_id`.

**SINGLE_ANSWER** — `answer` is `[scalePointId]`:
```json
{ "question_id": 2001, "parent_question_id": 2000, "answer": [6003] }
```

**MULTIPLE_ANSWER** — `answer` is `[scalePointId, scalePointId, ...]`:
```json
{ "question_id": 2001, "parent_question_id": 2000, "answer": [6001, 6003] }
```

**DROP_DOWN** — `answer` is `[choiceId]` from the column's dropdown:
```json
{ "question_id": 2001, "parent_question_id": 2000, "answer": [7005] }
```

**TEXT_INPUT** — `answer` is `[columnId, columnId, ...]`, `matrix_txt` is
the corresponding text array:
```json
{
  "question_id": 2001,
  "parent_question_id": 2000,
  "answer": [6001, 6002, 6003],
  "matrix_txt": ["Needs work", "Good", "Excellent"]
}
```

**RATING** — `answer` is `[columnId, columnId, ...]`, `matrix_int` is the
ratings array:
```json
{
  "question_id": 2001,
  "parent_question_id": 2000,
  "answer": [6001, 6002, 6003],
  "matrix_int": [3, 4, 5]
}
```

### BipolarMatrix

Same shape as Matrix SINGLE_ANSWER — one answer per row, `[scalePointId]`.

### GroupRating

Each statement (sub-question) is its own answer with numeric rating.

```json
{ "question_id": 3001, "parent_question_id": 3000, "answer": 4 }
```

### ConstantSum

Each row/item is its own answer with a numeric value. Sum across rows
should equal the configured `total_sum`.

```json
{ "question_id": 4001, "parent_question_id": 4000, "answer": 40 }
```

### ContactForm

Each field is its own answer with `parent_question_id`. The `answer`
format depends on the field's `row_type`.

| `row_type` | `answer` |
|---|---|
| `string` | `"Jane Doe"` |
| `number` | `42` |
| `email` | `"jane@example.com"` |
| `PhoneNumber` | `"+14155550123"` (no region_code on this sub-answer per docs — confirm in real test) |
| `date` | `"15/01/2024"` plus `time_zone` |
| `dropdown` | `[choiceId]` |

```json
{ "question_id": 5001, "parent_question_id": 5000, "answer": "Jane" },
{ "question_id": 5002, "parent_question_id": 5000, "answer": "Doe" },
{ "question_id": 5003, "parent_question_id": 5000, "answer": "jane@example.com" },
{ "question_id": 5004, "parent_question_id": 5000, "answer": "+14155550123" },
{ "question_id": 5005, "parent_question_id": 5000, "answer": "15/01/2024", "time_zone": "America/New_York" },
{ "question_id": 5006, "parent_question_id": 5000, "answer": [7002] }
```

Plumage fills ContactForm sub-fields from persona data (no LLM call):
- string → use the field label as a hint (First Name → `persona.firstName`,
  Last Name → `persona.lastName`, Full Name → `persona.name`, default →
  `persona.firstName + " " + persona.lastName`)
- email → `persona.email`
- PhoneNumber → `persona.phone`
- number → random or static based on label (Age → 25–60)
- date → some date from persona's submission window
- dropdown → first choice (or random if needed)

### NPSScore / CESScore / CSATScore (CX surveys)

`answer` is numeric within the score range (0–10 NPS, 1–5 CSAT, 1–7 CES).

```json
{ "question_id": 6001, "answer": 9 }
```

### NPSFeedback / CESFeedback / CSATFeedback (CX surveys)

Free-text follow-up to a CX score question.

```json
{ "question_id": 6002, "answer": "Great product, would recommend." }
```

---

## Complete example payload

```json
{
  "survey_id": 1,
  "trigger_workflow": false,
  "variables": { "plan_type": "Enterprise" },
  "meta_data": {
    "os": "macOS",
    "browser": "Chrome",
    "time_zone": "Asia/Calcutta",
    "date_time": "2024-01-15T10:30:00.000Z",
    "device_type": "COMPUTER",
    "language": "English",
    "tags": ["plumage-2026-05"]
  },
  "answers": [
    { "question_id": 1001, "answer": "The support team was very responsive." },
    { "question_id": 1006, "answer": 8 },
    { "question_id": 1010, "answer": [5001, 5003] },
    { "question_id": 1013, "answer": "15/01/2024 14:30", "time_zone": "Asia/Calcutta" },
    { "question_id": 2001, "parent_question_id": 2000, "answer": [6003] },
    { "question_id": 2002, "parent_question_id": 2000, "answer": [6001] },
    { "question_id": 3001, "parent_question_id": 3000, "answer": 4 },
    { "question_id": 4001, "parent_question_id": 4000, "answer": 40 },
    { "question_id": 4002, "parent_question_id": 4000, "answer": 30 },
    { "question_id": 4003, "parent_question_id": 4000, "answer": 30 }
  ]
}
```

---

## Critical builder rules

1. **Duplicate `question_id` → 409.** The builder must produce a flat array
   where each `question_id` appears exactly once. Sub-questions (matrix
   rows, contact form fields, etc.) have their own unique IDs and parent
   pointers.
2. **`trigger_workflow: false`.** Demo data should never fire automation
   rules. This is mandatory.
3. **`region_code` for PhoneNumber.** Use `persona.country` (alpha-2).
4. **`time_zone` for DateTime.** IANA name from `persona.timezone`.
5. **DateTime format must match the question's `date_format`.** Read from
   `question.properties.data.date_format`. Fallback to `DDMMYYYY` if
   missing.
6. **`device_type` is uppercase.** Map persona's title-case to `COMPUTER`
   / `MOBILE` / `TABLET`.
7. **YesNo answer is a string, not boolean.** `"Yes"` / `"No"` (or custom
   labels from `properties.data.yes_text` / `no_text`).
8. **Consent answer IS a boolean.**
9. **Single-select MultiChoice / Dropdown is `[choiceId]`, not `choiceId`.**
10. **CX surveys require their score question.** NPSScore in NPS surveys,
    CSATScore in CSAT, CESScore in CES — submitting without one returns 409.
11. **Variables are keyed by `apiIdentifier`, not by SS variable ID.** SS
    resolves the name internally. (We still pre-create variables via
    `POST /v3/variables/batch` so they exist before push.)

---

## API quirks to test for in 5c

- **Region code on ContactForm phone sub-field** — docs don't show
  `region_code`, but the standalone PhoneNumber requires it. Test both
  with and without and see which SS accepts.
- **Browser language format** — `en-US` vs `en-GB` vs `en` — verify what
  SS accepts.
- **Empty `tags` array** — confirm whether `[]` or omitting is preferred.
- **`channel_id` requirement** — if SS rejects responses without it for
  certain surveys, we'll need to fetch and pick a default channel.

These are unknowns for the real-workspace verification step in 5c.
