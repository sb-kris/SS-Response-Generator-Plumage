# SurveySparrow question type payloads — reference

> ⚠️ **Important caveat:** these are payloads for `POST /v3/questions`
> (creating questions in a survey), NOT for `POST /v3/responses` (submitting
> answers). They show how each question type is **defined** on SS — useful
> for understanding choice/scale/matrix structures the LLM must answer to.
>
> The actual response submission payload is different and should be
> verified against `POST /v3/responses` docs and a real `GET
> /v3/responses?survey_id=X` payload from the user's workspace before
> implementing the response-builder in Phase 5c.

All requests wrap the question inside a top-level envelope:

```json
{
  "survey_id": 1,
  "section_id": 2,
  "question": { ... }
}
```

Common optional fields on every question type:

| Field | Type | Notes |
|---|---|---|
| `description` | string | Sub-text shown below the question |
| `required` | boolean | Whether a response is mandatory |
| `randomized` | boolean | Randomise choice order |
| `tags` | string[] | Alphanumeric tag names |
| `display_logic` | object | Conditional visibility via custom variable |

---

## 1. TextInput

```json
{
  "text": "Tell us about your experience",
  "type": "TextInput",
  "properties": { "data": { "type": "SINGLE_LINE" } }
}
```

`data.type`: `"SINGLE_LINE"` | `"MULTI_LINE"`

Optional `properties.data` fields:
- `audio_transcription`: boolean — allow voice answers
- `analyze_sentiment`: boolean — run sentiment analysis

## 2. EmailInput

```json
{ "text": "What is your email address?", "type": "EmailInput" }
```

## 3. NumberInput

```json
{ "text": "How old are you?", "type": "NumberInput" }
```

## 4. PhoneNumber

```json
{ "text": "What is your phone number?", "type": "PhoneNumber" }
```

## 5. URLInput

```json
{ "text": "What is your company website?", "type": "URLInput" }
```

## 6. MultiChoice

Single-select or multi-select.

```json
{
  "text": "Which features do you use?",
  "type": "MultiChoice",
  "choices": [
    { "text": "Reporting" },
    { "text": "Integrations" },
    { "text": "Automations" }
  ],
  "multiple_answers": true,
  "other": true,
  "other_text": { "text": "Other (please specify)" }
}
```

Choice-count controls inside `properties.data`:
- `type`: `"UNLIMITED"` (default) | `"EXACT"` | `"RANGE"`
- `EXACT` requires `exactChoices: number`
- `RANGE` requires `minLimit: number`, `maxLimit: number`

Other top-level fields:
- `hasScore` — true when passing `score` on choices
- `none_of_the_above` — adds "None of the above" option
- `all_of_the_above` — adds "All of the above" (requires multiple_answers)

## 7. Dropdown

```json
{
  "text": "What is your country?",
  "type": "Dropdown",
  "choices": [
    { "text": "United States" },
    { "text": "United Kingdom" },
    { "text": "India" }
  ]
}
```

## 8. Rating

```json
{
  "text": "How would you rate our support?",
  "type": "Rating",
  "properties": {
    "data": {
      "rating_scale": 5,
      "icon_array_name": "RATING_STAR"
    }
  }
}
```

`icon_array_name`: `RATING_STAR` | `RATING_CROWN` | `RATING_LIGHTNING` |
`RATING_SMILEY` | `RATING_THUMBSUP` | `RATING_USER`

`rating_scale`: 3–10

## 9. OpinionScale

```json
{
  "text": "How likely are you to recommend us?",
  "type": "OpinionScale",
  "properties": {
    "data": {
      "step": 10,
      "start": 0,
      "min": "Not at all likely",
      "max": "Extremely likely"
    }
  }
}
```

`data` fields:
- `step`: 3–12 (scale size)
- `start`: 0 or 1
- `min`, `max`, `mid`: scale-end labels (mid is ClassicForm only)
- `reverse_scale`: boolean

## 10. YesNo

```json
{
  "text": "Did our team resolve your issue?",
  "type": "YesNo",
  "properties": {
    "data": {
      "yes_text": "Yes",
      "no_text": "No",
      "icon_shape": "YES_NO_ICON_TICK_CROSS_PRINT"
    }
  }
}
```

`icon_shape`: `YES_NO_ICON_TICK_CROSS_PRINT` | `YES_NO_ICON_THUMBS`

## 11. DateTime

```json
{
  "text": "When is your availability?",
  "type": "DateTime",
  "properties": {
    "data": {
      "type": "DATETIME",
      "date_format": "DDMMYYYY",
      "time_format": "TWELVE_HOUR",
      "show_calendar": true
    }
  }
}
```

`type`: `DATETIME` | `DATE_ONLY`
`date_format`: `MMDDYYYY` | `DDMMYYYY` | `YYYYMMDD`
`time_format`: `TWELVE_HOUR` | `TWENTY_FOUR_HOUR`

## 12. Matrix

```json
{
  "text": "Rate the following aspects",
  "type": "Matrix",
  "column": [
    { "name": "Poor" },
    { "name": "Average" },
    { "name": "Good" },
    { "name": "Excellent" }
  ],
  "row": [
    { "left_text": "Product quality" },
    { "left_text": "Customer support" },
    { "left_text": "Value for money" }
  ],
  "properties": { "data": { "type": "SINGLE_ANSWER" } }
}
```

`data.type`: `SINGLE_ANSWER` | `MULTIPLE_ANSWER` | `TEXT_INPUT` |
`DROP_DOWN` | `RATING`

For DROP_DOWN, include `choices` inside each column.

## 13. BipolarMatrix

```json
{
  "text": "Rate each attribute",
  "type": "BipolarMatrix",
  "column": [
    { "name": "1" }, { "name": "2" }, { "name": "3" }, { "name": "4" }, { "name": "5" }
  ],
  "row": [
    { "left_text": "Slow", "right_text": "Fast" },
    { "left_text": "Difficult", "right_text": "Easy" }
  ]
}
```

Min 3 columns, min 1 row.

## 14. RankOrder

```json
{
  "text": "Rank the following from most to least important",
  "type": "RankOrder",
  "choices": [
    { "text": "Price" }, { "text": "Quality" },
    { "text": "Speed" }, { "text": "Support" }
  ]
}
```

## 15. GroupRank

```json
{
  "text": "Group and rank these features",
  "type": "GroupRank",
  "choices": [
    { "text": "Dark mode" },
    { "text": "Offline access" },
    { "text": "Export to PDF" }
  ],
  "properties": {
    "data": {
      "is_ranking_enabled": true,
      "can_randomise_features_list": false,
      "can_repeat_feature": false
    }
  }
}
```

## 16. GroupRating

```json
{
  "text": "Rate the following",
  "type": "GroupRating",
  "row": [
    { "left_text": "Ease of use" },
    { "left_text": "Design" },
    { "left_text": "Performance" }
  ],
  "properties": {
    "data": { "rating_scale": 5, "icon_array_name": "RATING_STAR" }
  }
}
```

## 17. ConstantSum

```json
{
  "text": "Distribute 100 points across these priorities",
  "type": "ConstantSum",
  "row": [
    { "left_text": "New Features" },
    { "left_text": "Bug Fixes" },
    { "left_text": "Performance" }
  ],
  "properties": {
    "data": {
      "type": "TEXT",
      "total_sum": 100,
      "show_total": true,
      "symbol": "$",
      "symbol_position": "PREFIX"
    }
  }
}
```

`data.type`: `TEXT` | `SLIDER`
`symbol_position`: `PREFIX` | `SUFFIX`
Optional: `minLimit`, `maxLimit`, `segments` (0–10)

## 18. Slider

```json
{
  "text": "How satisfied are you overall?",
  "type": "Slider",
  "properties": {
    "data": {
      "slider_type": "lineSlider",
      "min": "0",
      "max": "100",
      "segments": 5,
      "show_progress": true,
      "decimals": 0
    }
  }
}
```

`slider_type`: `lineSlider` | `smileySlider` | `trafficLightSlider` |
`thermometerSlider` | `gaugeSlider`

## 19. ContactForm

```json
{
  "text": "Please enter your contact details",
  "type": "ContactForm",
  "row": [
    { "left_text": "First Name", "row_type": "string", "required": true },
    { "left_text": "Last Name",  "row_type": "string", "required": true },
    { "left_text": "Email",      "row_type": "email",  "required": true },
    { "left_text": "Phone",      "row_type": "PhoneNumber", "required": false },
    { "left_text": "Age",        "row_type": "number", "required": false },
    { "left_text": "Birthday",   "row_type": "date",   "required": false }
  ]
}
```

`row_type`: `string` | `number` | `email` | `date` | `PhoneNumber` | `dropdown`
For `dropdown`, include `choices` array on that row.

## 20. FileInput

```json
{
  "text": "Upload your resume",
  "type": "FileInput",
  "properties": {
    "data": {
      "fileTypes": ["doc", "image"],
      "maximum_number_of_files": 1
    }
  }
}
```

`fileTypes`: `image` | `doc` | `video` | `audio`
`maximum_number_of_files`: 1–5

## 21. CameraInput

```json
{ "text": "Take a photo of your receipt", "type": "CameraInput" }
```

## 22. AudioInput

```json
{ "text": "Record your feedback", "type": "AudioInput" }
```

## 23. Signature

```json
{
  "text": "Please sign below to confirm",
  "type": "Signature",
  "properties": {
    "data": {
      "draw_signature": true,
      "type_signature": true,
      "upload_signature": false
    }
  }
}
```

## 24. Consent

```json
{
  "text": "Do you agree to our terms?",
  "type": "Consent",
  "properties": {
    "data": {
      "consent_text": "I agree to the terms and conditions.",
      "show_terms_and_condition": true
    }
  }
}
```

## 25. Message

```json
{
  "text": "Thank you for completing this section!",
  "type": "Message",
  "properties": { "data": { "wait": 2 } }
}
```

`wait`: 0–15 seconds, Conversational survey type only.

## 26. PaymentQuestion

```json
{
  "text": "Complete your purchase",
  "type": "PaymentQuestion",
  "properties": { "data": { "currency": "USD", "amount": 49.99 } }
}
```

Optional discount:
```json
"discount": {
  "active": true,
  "discount_coupons": [
    { "coupon_code": "SAVE20", "discount_type": "Percentage", "percentage": 20 }
  ]
}
```

`discount_type`: `Amount` | `Percentage`

## 27. NPSFeedback (CX surveys only)

```json
{
  "text": "What is the primary reason for your score?",
  "type": "NPSFeedback",
  "properties": {
    "data": {
      "promoter": "What did you love most?",
      "passive": "How can we improve?",
      "detractor": "What went wrong?",
      "include_feedback_by_rating": true
    }
  }
}
```

## 28. CESFeedback (CX surveys only)

```json
{
  "text": "Tell us more about your experience",
  "type": "CESFeedback",
  "properties": {
    "data": {
      "low_effort": "That was easy!",
      "neutral": "It was okay.",
      "high_effort": "It was difficult.",
      "include_feedback_by_rating": true
    }
  }
}
```

## 29. CSATFeedback (CX surveys only)

```json
{
  "text": "What can we do better?",
  "type": "CSATFeedback",
  "properties": {
    "data": {
      "satisfied": "Keep it up!",
      "dissatisfied": "Sorry to hear that.",
      "include_feedback_by_rating": true
    }
  }
}
```

---

## Notes

- **Feature-gated:** `BipolarMatrix`, `Matrix`, `RankOrder`, `GroupRank`,
  `FileInput`, `PaymentQuestion` require specific plan features. API
  returns 402 if not available.
- **CX-only:** `NPSFeedback`, `CESFeedback`, `CSATFeedback` only on NPS,
  CES, CSAT survey types respectively.
- **Employee360:** `section_id` required; `Matrix`/`ConstantSum` need
  `MATRIX_CONSTANT_SUM_EMP360` feature; `properties` cannot be passed in E360.
- **Conversational:** `Message.wait` only valid for Chat surveys.

---

## Phase 5a relevance — what the LLM needs to answer

For Plumage's response generation prompt, only the **answerable** types
matter (per `lib/surveysparrow/question-types.ts`):

| Question type | LLM must produce |
|---|---|
| TextInput | Free-text string |
| EmailInput | Email-formatted string (Plumage uses persona.email) |
| NumberInput | Number |
| PhoneNumber | Phone string (Plumage uses persona.phone) |
| URLInput | URL string |
| MultiChoice (single) | One choice ID |
| MultiChoice (multiple) | Array of choice IDs |
| Dropdown | One choice ID |
| Rating | Integer in `1..rating_scale` |
| OpinionScale | Integer in `start..start+step` |
| YesNo | Boolean |
| DateTime | ISO 8601 string |
| Matrix | Map of rowId → columnId (or array of IDs for MULTIPLE_ANSWER) |
| BipolarMatrix | Same as Matrix |
| RankOrder | Ordered array of choice IDs |
| GroupRank | Ordered array of choice IDs (with grouping if enabled) |
| GroupRating | Per-row rating value |
| ConstantSum | Per-row numeric distribution summing to total_sum |
| Slider | Numeric value in min..max |
| ContactForm | Per-row typed values (Plumage uses persona contact data) |
| NPS | Integer 0–10 |
| CSAT | Integer 1–5 |
| CES | Integer 1–7 |
| NPSFeedback / CESFeedback / CSATFeedback | Free-text string |

Skipped (not LLM-answered):
- Welcome, Thank-you, Message, Consent (screens)
- FileInput, CameraInput, AudioInput, Signature (media)
- PaymentQuestion (out of scope for demos)
