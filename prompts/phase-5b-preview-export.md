# Phase 5b — Polished Preview UI + CSV/XLSX Export

> Paste this into a fresh Claude Code session AFTER Phase 5a is complete and
> the user has confirmed prompt quality is excellent. This phase is short
> and contained — no LLM work, no SS API calls. Plan for one focused session.

## Where the project stands

Plumage is an internal SurveySparrow Presales tool that generates demo
survey responses. Phases 1–4 + Phase 5a are complete:

- Phase 1: Auth + Setup
- Phase 2: Survey selection + question loading
- Phase 3: Configure wizard
- Phase 4: Persona synthesis (LLM)
- Phase 5a: Response generation (LLM) — the responses-store now holds an
  array of `GeneratedResponse` for the current persona set, and the
  `BasicPreviewCard` shows them in a minimal table with JSON dumps.

Your job: replace `BasicPreviewCard` with a polished preview UI and add CSV
+ XLSX export. No new API routes, no LLM calls, no SS pushes.

**Stack:** Next.js 15.5.16 · TypeScript strict · pnpm · Zustand · Tailwind +
shadcn/ui. New deps to add: `papaparse` (CSV), `xlsx` aka SheetJS (XLSX).

## Architectural patterns to preserve

- All export work is **client-side**. No server route. The
  user clicks Download → blob is generated in the browser → `<a download>`
  triggers the file save.
- `papaparse` and `xlsx` both work in the browser. Add as deps to
  `package.json` via `pnpm add papaparse xlsx` plus
  `pnpm add -D @types/papaparse`.
- Don't break the State A / B / C / D / E machine in
  `GenerateAndPushStep.tsx`. You're only swapping out the State C card.
- Don't touch the responses-store schema. If you need derived data, compute
  in selectors / memos.

## Deliverables

### 1. `components/generate/generate/PreviewCard.tsx` — polished State C

Replaces `BasicPreviewCard.tsx` (delete or keep as fallback — your call).
Wired into `GenerateAndPushStep.tsx`.

**Top stats bar** (full width):
- "N responses generated" with green check icon
- Avg NPS (if any NPS questions exist) — color-coded badge
- Avg CSAT (if any CSAT questions exist)
- Sentiment distribution mini-bar (3-segment colored bar showing
  promoter/passive/detractor counts)
- Top 3 themes mentioned in open-text answers (simple word-frequency on
  open-text values, lowercased, stop-words filtered) — small chips

Use `summarizeResponses()` from `lib/generation/response-types.ts` if it
exists; if not, build a `lib/generation/response-summarizer.ts` helper.

**Search bar**:
- Input above the table, placeholder "Search by name, country, sentiment, or
  answer text…"
- Filters the table client-side. Match across persona name, country,
  language, sentiment, and any open-text answer values. Case-insensitive
  substring match.

**Response table**:

| # | Avatar | Name | Lang | Country | Sentiment | Top concern | (expand) |

- DiceBear avatar by `personaId` seed (same as Phase 4 — see
  `PersonaTable.tsx`)
- Sentiment as colored badge (green=promoter, yellow=passive, red=detractor)
- "Top concern" = `keyConcerns[0]` truncated to 60 chars
- Show first **20** rows by default, "Show all N" CTA below to expand

**Expanded row** (click row to toggle):
- Renders each answer in a typed-aware way:
  - **NPS:** large colored number badge (green 9–10, yellow 7–8, red 0–6)
  - **CSAT/CES/Rating:** stars or numeric badge with "X / max"
  - **Open-text:** italicized in a quoted block, with a small lang tag if
    non-English
  - **Single-choice / Dropdown:** selected option as a pill with the label
  - **Multi-choice:** comma-separated list of selected option labels
  - **Yes/No:** ✓ Yes / ✗ No badge
  - **Matrix:** small grid showing each row → column mapping
  - **Ranking:** ordered numbered list of choice labels
  - **Number / Date / URL / Email / Phone:** plain monospace
- Question text shown above each answer (truncate to 100 chars with title
  attribute for full)

**Action bar** (sticky at bottom of card on desktop):
```
[📥 Download CSV]  [📥 Download XLSX]  [🔄 Re-generate]  [🚀 Push to SurveySparrow]
```

The Push button is a **placeholder** in 5b — clicking it shows a toast
"Push functionality ships in Phase 5c." 5c will wire it for real. Don't
disable it; the visual presence is part of the UX.

### 2. `lib/utils/response-export.ts` — exporters

Two functions, both **synchronous** and returning a `Blob`:

```ts
export function buildResponseCsv(input: ExportInput): Blob;
export function buildResponseXlsx(input: ExportInput): Blob;

export interface ExportInput {
  responses: GeneratedResponse[];
  personas: Persona[];                   // looked up by personaId
  questions: QuestionDisplay[];          // ordered by position
  customVariables: CustomVariable[];
  surveyName: string;
}
```

#### CSV columns (match SS export format from user's reference file)

System columns (in this order):
- `Date Submitted` — ISO date from `persona.submittedAt`
- `Time Taken to Complete` — synthesize a plausible duration (e.g. 30s–8min
  weighted by `verbosity`); render as `mm:ss`
- `Submitted From (IP Address)` — `persona.ipAddress` or empty
- `Submitted From (Country)` — `persona.countryName`
- `Submitted From (Region)` — `persona.region`
- `Submitted From (City)` — `persona.city`
- `Submitted From (Latitude)` — `persona.latitude`
- `Submitted From (Longitude)` — `persona.longitude`
- `Submitted From (Device)` — `persona.deviceType`
- `Submitted From (Browser)` — `persona.browser`
- `Submitted From (Operating System)` — `persona.os`
- `Submitted From (Language)` — language name from
  `LANGUAGES_BY_CODE[persona.language].name`
- `Submitted From (Distribution)` — empty (SS uses this for share-channel;
  Plumage doesn't model it)
- `Submitted From (Timezone)` — `persona.timezone`
- `Submitted From (User Agent)` — `persona.userAgent`

Contact columns:
- `contact_email` — `persona.email`
- `Contact First Name` — `persona.firstName`
- `Contact Last Name` — `persona.lastName`
- `Contact Phone` — `persona.phone`

Custom variable columns (one per `customVariable.apiIdentifier`):
- Header: variable's `apiIdentifier`
- Value: `persona.variableValues[apiIdentifier]` or empty

Question columns (one per answerable question, in question position order):
- Header: question text (HTML-stripped, truncated to 250 chars)
- Value: rendered answer:
  - Open-text → raw value
  - NPS/CSAT/CES/rating/opinion_scale → numeric
  - Single-choice / dropdown → choiceLabel
  - Multi-choice → comma-separated labels
  - Yes/No → "Yes"/"No"
  - Matrix → semicolon-separated `rowLabel: columnLabel` pairs
  - Ranking → semicolon-separated ordered labels
  - Number/Date/URL/Email/Phone → raw value

Tags column:
- Header: `Tags`
- Value: comma-separated from `persona.tags` (or the tags from
  `systemMetadata.tags.values`, applied uniformly per response)

Use papaparse's `unparse()` with `header: true`, `quotes: true` (force-quote
fields containing commas/quotes/newlines), `newline: "\r\n"` (Excel-friendly).

Filename:
`plumage-{slugify(surveyName)}-{format(now, "yyyy-MM-dd-HHmm")}.csv`

#### XLSX columns

Use `xlsx` (SheetJS) with two sheets:

**Sheet 1: "Responses"** — same columns as CSV. Apply:
- Bold header row (`workbook.Sheets[name]["!rows"]` + cell `s.font.bold`)
- Auto-sized columns (compute max width per column or use 20 char default)
- Frozen first row (`worksheet["!freeze"] = { ySplit: 1 }`)
- Filter on header row

**Sheet 2: "Personas"** — context for the SE who downloaded:
- `Persona ID`, `Name`, `Sentiment`, `Verbosity`, `Language`, `Country`,
  `City`, `Top Concern 1/2/3`, `Themes`, `Demographic Notes`

Filename:
`plumage-{slugify(surveyName)}-{format(now, "yyyy-MM-dd-HHmm")}.xlsx`

Slugify rule: lowercase, replace non-alphanumerics with `-`, collapse runs,
trim leading/trailing `-`. Inline helper, don't pull in another lib.

### 3. Download trigger helpers

Add minimal helpers that take a `Blob` + filename and trigger the download:

```ts
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

Wire to the action bar buttons. Show a `sonner` toast on download start and
on success (small UX feedback so the click feels alive).

### 4. Optional: persistent search/expand state

If polish budget allows, persist the search query and expanded row IDs in a
local component-state ref so toggling between cards doesn't lose them.
Don't put this in Zustand — it's ephemeral UI state.

## Smoke gates

```
pnpm typecheck   → clean
pnpm lint        → clean
pnpm build       → compiles (verify the xlsx + papaparse bundle hit isn't
                   catastrophic — both should code-split into the generate
                   route only)
```

## Verification

1. With a 50-response generation in the store from 5a:
   - Search filters update the table immediately
   - Click row to expand → all answers render with their type-specific UI
   - Stats bar shows reasonable averages
2. Download CSV:
   - Open in Excel/Numbers
   - Header row matches SS export format
   - All columns populated
   - Custom variable columns present (verify against the configured
     variables)
   - Tags column populated
   - Multi-choice values comma-separated
3. Download XLSX:
   - Open in Excel/Numbers
   - Bold header row
   - Frozen first row
   - Filter dropdowns on header
   - Personas sheet populated
4. Re-generate button resets State C → State A correctly.
5. Push button shows the "ships in Phase 5c" toast.

## Out of scope for 5b

- Variable creation in SS — that's 5c
- Push to SurveySparrow — 5c
- "Skip preview" toggle wiring — 5c
- State D (pushing) and State E (complete) — 5c
- Bulk delete — 5c
- History page — Phase 6

## File checklist

- [ ] `package.json` — add `papaparse`, `xlsx`, `@types/papaparse`
- [ ] `lib/utils/response-export.ts`
- [ ] `lib/generation/response-summarizer.ts` (only if not already in
      response-types.ts from 5a)
- [ ] `components/generate/generate/PreviewCard.tsx`
- [ ] `components/generate/generate/GenerateAndPushStep.tsx` — swap
      BasicPreviewCard → PreviewCard
- [ ] (delete or rename) `components/generate/generate/BasicPreviewCard.tsx`

## Reference files

- `components/generate/synthesize/PersonaTable.tsx` — DiceBear avatars,
  table styling
- The user's CSV file `Responses_-_Product_Feedback_-_Post_Purchase_-_07_May_2026.csv`
  for the canonical column structure (ask the user to share it again if
  it's not in the repo)
- `lib/utils/language-geography.ts` — `LANGUAGES_BY_CODE` for language
  display names
