// Phase 5a — Response generation prompt.
//
// THE highest-leverage file in the codebase. One prompt → one persona's
// complete answer set across all answerable questions in the survey.
//
// Design choices to call out:
//
// 1. The LLM does NOT label each answer with a `type` field. Instead the
//    output JSON is keyed by question id with the value shape implicitly
//    matching the question type. The validator looks up the question's SS
//    type to interpret the value. Reasoning: LLMs occasionally drop or
//    misspell discriminator fields; making the value shape itself the
//    discriminator is more robust.
//
// 2. Choice answers are ALWAYS arrays — single-select is `[choiceId]`,
//    multi-select is `[id, id, …]`. This mirrors the SS wire format and
//    avoids the LLM oscillating between scalar and array forms.
//
// 3. We render only `answerable` questions (per the registry). Email /
//    phone / URL standalone questions are non-answerable in Plumage's
//    registry — the 5c push builder fills those from persona contact data
//    if a survey requires them. Welcome / thank-you / file-upload / etc.
//    screens are also skipped.
//
// 4. Sentiment alignment is baked into the prompt with concrete numeric
//    bounds (promoter NPS 9–10, etc.). The validator ALSO enforces these,
//    but the prompt rule reduces validation failures + retries.
//
// 5. We always send the persona's `language` as both the ISO code AND the
//    full display name with explicit "write open-text in $LANG" reminders.
//    Repeat is intentional — non-English open-text leaking back to English
//    is the most common observed failure mode.

import type { Persona } from "@/lib/generation/persona-types";
import type { Question } from "@/lib/surveysparrow/types";
import {
  compareQuestionPositions,
  extractQuestionColumns,
  extractQuestionDisplay,
  extractQuestionRows,
  resolveScale,
} from "@/lib/surveysparrow/types";
import {
  getQuestionTypeMeta,
  type QuestionTypeMeta,
} from "@/lib/surveysparrow/question-types";
import { LANGUAGES_BY_CODE } from "@/lib/utils/language-geography";
import type { AnswerType } from "@/lib/generation/response-types";

// ---------------------------------------------------------------------------
// Batch system prompt (used when generating answers for multiple personas in
// one LLM call to reduce total API round-trips).
// ---------------------------------------------------------------------------

const BATCH_SYSTEM_PROMPT = `You are simulating multiple survey respondents simultaneously. You will be given several distinct personas and one survey, and you must produce the complete answer set for EACH persona — staying in character for each one independently.

CRITICAL RULES (apply to every persona):
1. Each persona is a distinct person. Their answers must reflect their unique sentiment, concerns, and demographics — not each other's.
2. Maintain internal coherence per persona: a Promoter must not write complaints; a Detractor must not rate things highly.
3. Open-text answers MUST be written natively in each persona's assigned language — NOT translated from English.
4. Sentiment ↔ rating coherence is mandatory:
   - promoter:  NPS 9-10  | CSAT 4-5 | ratings near top of scale  | positive open-text
   - passive:   NPS 7-8   | CSAT 3   | mid-scale ratings           | mixed open-text
   - detractor: NPS 0-6   | CSAT 1-2 | low-end ratings             | specific complaints
5. For choice/dropdown/ranking questions, return the choice ID (integer from the options list), NEVER the label text.
6. NEVER break character. NEVER add preamble or meta-commentary. Output is JSON only.
7. Answer EVERY question for every persona — required AND optional, single-choice, multi-choice, opinion-scale, text, ratings, all of it. Visibility filtering is Plumage's job: AFTER you respond, Plumage automatically drops answers for questions a given persona wouldn't have seen (based on the survey's display_logic). So don't try to "be helpful" by omitting questions you think might not apply — that's our filter's job, not yours. If a question's options or wording feel sentiment-mismatched (e.g. a complaint-themed text box for a Promoter), still answer it in-character; we'll discard it server-side if needed. Multi-select questions need a NON-EMPTY array of choice IDs (typically 2–4 picks); never return [], null, or omit the key.
8. Demo-richness rule: this is generated demo data, NOT field research. When offered a branching question (e.g. "Do you have time for more feedback?", "Which areas would you like to comment on?"), lean strongly toward EXPANSION — pick the answer that opens up more of the survey, and on multi-select "which areas?" pick 2–4 of the options. Demo dashboards need rich coverage across every section.

OUTPUT: A JSON array with exactly one object per persona, in the same order they are listed. Each object has an "answers" key.`;

// ---------------------------------------------------------------------------
// Survey context (re-uses the same shape as persona-prompt for symmetry)
// ---------------------------------------------------------------------------

export interface SurveyContext {
  surveyName: string;
  surveyDescription?: string;
  /** Free-form text from the Configure -> Context section. */
  useCase: string;
  /** Configured themes — passed for narrative consistency with persona-phase output. */
  themes: Array<{ label: string }>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BuildResponsePromptInput {
  persona: Persona;
  /** Raw SS questions — we use `extractQuestionDisplay()` internally and peek
   *  at `properties.data` for matrix subtypes. */
  questions: Question[];
  surveyContext: SurveyContext;
  /** Set on retry attempts. The summarized validator error is appended so the
   *  model can correct course. */
  retryReason?: string;
}

export interface BuildResponsePromptResult {
  systemPrompt: string;
  userPrompt: string;
  /** Question IDs the prompt asked about, in order — the validator uses this
   *  to verify completeness without re-deriving the answerable set. */
  expectedQuestionIds: string[];
  /** Map of questionId → expected internal AnswerValue.type. Drives the
   *  validator's per-question dispatch. */
  expectedAnswerTypes: Record<string, AnswerType>;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are simulating a survey respondent. You will be given a persona profile (a simulated customer) and a survey, and you must produce ALL of that person's answers to ALL questions in one response.

CRITICAL RULES:
1. Stay in character as the persona for the ENTIRE response. Same person, same opinions, same vocabulary, same emotional state across every answer.
2. Maintain internal coherence: a Promoter who rates NPS 9 should not write a complaining open-text answer. A Detractor who rates 2/5 should not select "Highly satisfied" on a multiple-choice.
3. Match the persona's verbosity:
   - terse: 1 short sentence for open-text, no fluff
   - medium: 2-3 sentences, natural conversational tone
   - verbose: 3-5 sentences, more detail and emotion
4. Reference the persona's specific keyConcerns and themesTouched in their open-text answers naturally — weave them into the answer, don't list them. Generate THIS person's feedback, not generic survey filler.
5. Open-text answers MUST be written natively in the persona's assigned language. NOT translated from English. Casual register, not textbook. Even minor English fragments in non-English answers are wrong.
6. Vary writing style realistically. Casual personas may have minor typos, run-on sentences, or informal phrasing. Verbose ones may be more formal. Match the demographic notes.
7. NEVER break character to explain what you're doing. NEVER include preamble, apologies, or meta commentary. Your output is JSON only.
8. For choice/dropdown/multi-choice/ranking questions, return the choice ID (the integer from the options list), NEVER the choice label as text.
9. Sentiment ↔ rating coherence is mandatory:
   - promoter:  NPS 9-10  | CSAT 4-5 | ratings near top of scale  | mostly positive open-text
   - passive:   NPS 7-8   | CSAT 3   | mid-scale ratings           | mixed / lukewarm open-text
   - detractor: NPS 0-6   | CSAT 1-2 | low-end ratings             | specific complaints in open-text
10. Answer EVERY question — required AND optional, single-choice, multi-choice, opinion-scale, text, ratings, all of it. Visibility filtering is Plumage's job: AFTER your response, Plumage automatically drops answers for questions you wouldn't have seen (based on the survey's display_logic). So don't second-guess which questions "apply" — answer them and let our filter handle it. Multi-select questions need a NON-EMPTY array of choice IDs (typically 2–4 picks); never return [], null, or omit the key.
11. Demo-richness rule: this is demo data, not field research. When offered a branching question (e.g. "Do you have time for more feedback?", "Which areas to comment on?"), lean toward EXPANSION — pick the answer that opens up more of the survey, and on multi-select "which areas?" pick 2–4 options. Demo dashboards need rich coverage across every section.

OUTPUT: Strict JSON. No markdown wrapping, no fences, no prose before or after.`;

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export function buildResponsePrompt(
  input: BuildResponsePromptInput,
): BuildResponsePromptResult {
  const { persona, questions, surveyContext, retryReason } = input;

  // ---- Identify the answerable subset and infer expected internal types ---
  const renderedQuestions: RenderedQuestion[] = [];
  const expectedAnswerTypes: Record<string, AnswerType> = {};

  for (const q of questions) {
    const meta = getQuestionTypeMeta(q.type);
    if (!meta.answerable) continue;
    const display = extractQuestionDisplay(q);
    if (display.imageOnly) continue;

    const answerType = inferAnswerType(q, meta);
    if (!answerType) continue;

    expectedAnswerTypes[String(q.id)] = answerType;
    renderedQuestions.push({
      id: q.id,
      position: display.position,
      text: display.text,
      description: display.description,
      required: display.required,
      answerType,
      meta,
      raw: q,
      display,
    });
  }

  // Stable survey-walk order — uses (section.position, question.position)
  // via compareQuestionPositions. Sorting by question.position alone
  // scrambles order across sections; see compareQuestionPositions header
  // for the bug history.
  renderedQuestions.sort((a, b) => compareQuestionPositions(a.raw, b.raw));

  // ---- Build the persona block --------------------------------------------
  const langInfo = LANGUAGES_BY_CODE[persona.language];
  const langName = langInfo?.name ?? persona.language.toUpperCase();
  const concernsBlock = persona.keyConcerns.length
    ? persona.keyConcerns.map((c) => `- ${c}`).join("\n")
    : "- (no specific concerns)";
  const themesBlock = persona.themesTouched.length
    ? persona.themesTouched.map((t) => `- ${t}`).join("\n")
    : "- (no themes assigned)";

  const personaBlock = `PERSONA
Name: ${persona.firstName} ${persona.lastName}
Language: ${langName} (${persona.language})
Country: ${persona.countryName}, City: ${persona.city}
Sentiment archetype: ${persona.sentimentArchetype}
Verbosity: ${persona.verbosity}

This person's specific concerns (weave these into open-text answers naturally):
${concernsBlock}

Themes this person will touch on:
${themesBlock}

Demographic context:
${persona.demographicNotes || "(no extra context)"}`;

  // ---- Build the survey block ---------------------------------------------
  const surveyBlock = `SURVEY: "${surveyContext.surveyName}"${
    surveyContext.surveyDescription
      ? `\nSurvey description: ${surveyContext.surveyDescription}`
      : ""
  }
Use case context (the company running this survey):
${surveyContext.useCase || "(generic SaaS product context — keep answers neutral and product-feedback-shaped)"}`;

  // ---- Render each question -----------------------------------------------
  // Map by id so renderQuestion can resolve display_logic references
  // (e.g. "Q3 includes choice X") to friendly position labels + choice
  // text instead of bare numeric ids.
  const questionsById = new Map(renderedQuestions.map((q) => [q.id, q]));
  const questionsBlock = renderedQuestions
    .map((q) => renderQuestion(q, questionsById))
    .join("\n\n");

  // ---- Output schema with concrete examples for the LLM ------------------
  const schemaBlock = buildSchemaBlock(renderedQuestions);

  // ---- Final reminders + retry block --------------------------------------
  const remindersBlock = `INSTRUCTIONS:
- Answer EVERY question in the QUESTIONS block — required and optional, choice and text. Plumage handles visibility filtering (display_logic) AFTER your response — we'll drop any answer for a question the persona wouldn't have seen, so you don't need to think about that. Just answer everything in character. Multi-select questions need a NON-EMPTY array of choice IDs (typically 2–4 picks); NEVER return [], null, or omit the key.
- Demo coverage: this is demo data — we WANT rich, full surveys. When you're offered a branching question that decides whether to enter a deeper section (e.g. "Do you have three more minutes?", "Which areas would you like to comment on?"), lean toward EXPANSION: pick "Yes/continue" the majority of the time, and on multi-select "which areas?" pick 2–4 of the available choices (not zero). Demo dashboards need coverage across every section.
- Open-text answers MUST be in ${langName}, not English (unless ${langName} is English).
- For choice/dropdown/ranking questions, return choice IDs from the lists below — exact integers, never labels.
- Choose options that align with your sentiment archetype (${persona.sentimentArchetype}) and your stated concerns.
- Be specific. Reference your concerns. Avoid generic phrases like "great service" or "needs improvement".
- For ratings, follow the sentiment ↔ scale rules in the system prompt — these are mandatory.

Return ONLY the JSON object. No prose. No markdown.`;

  const retryBlock = retryReason
    ? `\n\nIMPORTANT: A previous attempt failed validation with: "${retryReason}". Re-read the schema and rules carefully before re-generating.`
    : "";

  const userPrompt = [
    personaBlock,
    "---",
    surveyBlock,
    "---",
    `QUESTIONS TO ANSWER (${renderedQuestions.length} total):\n\n${questionsBlock}`,
    "---",
    schemaBlock,
    "---",
    remindersBlock + retryBlock,
  ].join("\n\n");

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    expectedQuestionIds: renderedQuestions.map((q) => String(q.id)),
    expectedAnswerTypes,
  };
}

// ---------------------------------------------------------------------------
// Batch prompt — N personas, one shared question set, array output
// ---------------------------------------------------------------------------

export interface BuildBatchResponsePromptInput {
  personas: Persona[];
  questions: Question[];
  surveyContext: SurveyContext;
  retryReason?: string;
}

export interface BuildBatchResponsePromptResult {
  systemPrompt: string;
  userPrompt: string;
  expectedQuestionIds: string[];
  expectedAnswerTypes: Record<string, AnswerType>;
  /** Same order as input `personas`. */
  personaIds: string[];
}

export function buildBatchResponsePrompt(
  input: BuildBatchResponsePromptInput,
): BuildBatchResponsePromptResult {
  const { personas, questions, surveyContext, retryReason } = input;

  // Build the shared question list once.
  const renderedQuestions: RenderedQuestion[] = [];
  const expectedAnswerTypes: Record<string, AnswerType> = {};

  for (const q of questions) {
    const meta = getQuestionTypeMeta(q.type);
    if (!meta.answerable) continue;
    const display = extractQuestionDisplay(q);
    if (display.imageOnly) continue;
    const answerType = inferAnswerType(q, meta);
    if (!answerType) continue;
    expectedAnswerTypes[String(q.id)] = answerType;
    renderedQuestions.push({ id: q.id, position: display.position, text: display.text, description: display.description, required: display.required, answerType, meta, raw: q, display });
  }
  renderedQuestions.sort((a, b) => compareQuestionPositions(a.raw, b.raw));

  // Build one persona section per persona.
  const personaSections = personas.map((persona, idx) => {
    const langInfo = LANGUAGES_BY_CODE[persona.language];
    const langName = langInfo?.name ?? persona.language.toUpperCase();
    const concernsBlock = persona.keyConcerns.length
      ? persona.keyConcerns.map((c) => `- ${c}`).join("\n")
      : "- (no specific concerns)";
    const themesBlock = persona.themesTouched.length
      ? persona.themesTouched.map((t) => `- ${t}`).join("\n")
      : "- (no themes assigned)";

    return `=== PERSONA ${idx + 1} (id: ${persona.id}) ===
Name: ${persona.firstName} ${persona.lastName}
Language: ${langName} (${persona.language}) — write ALL open-text in ${langName}
Country: ${persona.countryName}, City: ${persona.city}
Sentiment archetype: ${persona.sentimentArchetype}
Verbosity: ${persona.verbosity}
Key concerns (weave into open-text naturally):
${concernsBlock}
Themes to touch on:
${themesBlock}
Demographic context: ${persona.demographicNotes || "(none)"}`;
  });

  const surveyBlock = `SURVEY: "${surveyContext.surveyName}"${
    surveyContext.surveyDescription ? `\nDescription: ${surveyContext.surveyDescription}` : ""
  }
Use case context: ${surveyContext.useCase || "(generic product context)"}`;

  const questionsByIdBatch = new Map(renderedQuestions.map((q) => [q.id, q]));
  const questionsBlock = renderedQuestions.map((q) => renderQuestion(q, questionsByIdBatch)).join("\n\n");

  const schemaBlock = `OUTPUT SCHEMA — return a JSON array with exactly ${personas.length} objects:

[
${personas.map((p, i) => `  { "answers": { /* ${p.firstName} ${p.lastName}'s answers */ } }${i < personas.length - 1 ? "," : ""}`).join("\n")}
]

Each "answers" object uses the same shape as a single-persona response:
- Numeric scales: integer
- Open text: string in the persona's own language
- Single choice / Dropdown: array of ONE choice ID e.g. [88]
- Multi choice: array of 1+ choice IDs
- Rank order: array of ALL choice IDs in ranked order
- Matrix (single/dropdown): { "<rowId>": <id>, ... }
- Matrix (multi): { "<rowId>": [<ids>], ... }
- Matrix (text): { "<rowId>": { "<colId>": "<text>" }, ... }
- Matrix (rating): { "<rowId>": { "<colId>": <int> }, ... }
- Group rating / Constant sum: { "<rowId>": <int>, ... }`;

  const retryBlock = retryReason
    ? `\n\nIMPORTANT: A previous attempt failed with: "${retryReason}". Fix the issues and regenerate all ${personas.length} persona answers.`
    : "";

  const userPrompt = [
    personaSections.join("\n\n"),
    "---",
    surveyBlock,
    "---",
    `QUESTIONS (${renderedQuestions.length} total — answer ALL for EACH persona):\n\n${questionsBlock}`,
    "---",
    schemaBlock + retryBlock,
  ].join("\n\n");

  return {
    systemPrompt: BATCH_SYSTEM_PROMPT,
    userPrompt,
    expectedQuestionIds: renderedQuestions.map((q) => String(q.id)),
    expectedAnswerTypes,
    personaIds: personas.map((p) => p.id),
  };
}

// ---------------------------------------------------------------------------
// Per-question rendering
// ---------------------------------------------------------------------------

interface RenderedQuestion {
  id: number;
  position: string;
  text: string;
  description?: string;
  required: boolean;
  answerType: AnswerType;
  meta: QuestionTypeMeta;
  raw: Question;
  display: ReturnType<typeof extractQuestionDisplay>;
}

function renderQuestion(
  q: RenderedQuestion,
  questionsById?: Map<number, RenderedQuestion>,
): string {
  const lines: string[] = [];
  const reqTag = q.required ? " [REQUIRED]" : "";
  lines.push(`Q${q.position} (id=${q.id})${reqTag}: ${q.text}`);
  if (q.description) {
    lines.push(`  Context: ${q.description}`);
  }

  // Visibility-gating (display_logic) is intentionally NOT shown to the
  // LLM here — this is a deliberate iteration-driven decision worth
  // recording, because the obvious instinct is to expose the gate.
  //
  // Iteration history:
  //   1. Original prompt: rendered "Conditional: only answer this if ..."
  //      for every gated question. Result: 0% answer rate on Q1004043885
  //      (multi-select gateway) across 90+ Fontainebleau responses.
  //   2. Flipped to positive framing ("SHOWN whenever X; you MUST answer
  //      when gate satisfied"). Result: 0% on the same question.
  //   3. Added a hyper-specific retry directive listing valid IDs. Result:
  //      still 0%. The model ignored the retry text entirely.
  //
  // Conclusion: the WORD "Conditional" + a multi-select + a gate triggers
  // a skip-prior in the model that no wording overcomes. So we move the
  // entire visibility decision server-side: the prompt presents every
  // answerable question as if it were unconditional, the LLM answers them
  // freely, and the validator's display_logic post-filter
  // (validateResponseOutput → computeShownQuestions) drops any answer
  // whose gate isn't actually satisfied by the persona's own picks.
  //
  // Cost: the model spends some tokens on answers that get filtered out
  // (e.g. a Promoter answering "what went wrong?"). That's a token-spend
  // trade we accept for guaranteed cascade coverage. cascade-injector.ts
  // adds a safety net for the rare case the model still misses a required
  // gated question — see that module for the post-retry recovery path.
  //
  // If you're tempted to re-introduce a Conditional hint here: don't,
  // unless you have evidence the model behaves differently for your
  // survey shape. Test it.

  switch (q.answerType) {
    case "nps":
      lines.push(`  Type: NPS — integer 0–10. (0 = Not at all likely, 10 = Extremely likely)`);
      break;
    case "csat":
      lines.push(`  Type: CSAT — integer 1–5. (1 = Very dissatisfied, 5 = Very satisfied)`);
      break;
    case "ces":
      lines.push(`  Type: CES — integer 1–7. (1 = Strongly disagree, 7 = Strongly agree — typically "It was easy to handle my issue")`);
      break;
    case "rating":
    case "opinion_scale":
    case "slider": {
      const scale =
        q.answerType === "opinion_scale" ? resolveScale(q.raw, 0, 10)
        : q.answerType === "slider" ? resolveScale(q.raw, 0, 100)
        : resolveScale(q.raw, 1, 5);
      const labels = extractScaleLabels(q.raw);
      const labelHint =
        labels.min || labels.max
          ? `  (${labels.min ?? "low"} ↔ ${labels.max ?? "high"})`
          : "";
      lines.push(
        `  Type: ${q.meta.label} — integer ${scale.min}–${scale.max}.${labelHint}`,
      );
      break;
    }
    case "yes_no":
      lines.push(`  Type: Yes/No — return true (Yes) or false (No).`);
      break;
    case "single_choice":
    case "dropdown": {
      lines.push(
        `  Type: ${q.meta.label} — return an array containing the single chosen choice ID. Options:`,
      );
      lines.push(formatChoices(q));
      break;
    }
    case "multi_choice": {
      const range = extractMultiChoiceRange(q.raw);
      lines.push(
        `  Type: Multi choice (multi-select) — return an array of 1+ chosen choice IDs.${
          range ? ` Pick ${range}.` : ""
        } Options:`,
      );
      lines.push(formatChoices(q));
      break;
    }
    case "ranking": {
      lines.push(
        `  Type: Rank order — return an ordered array of ALL choice IDs (first = highest rank, last = lowest). Options:`,
      );
      lines.push(formatChoices(q));
      break;
    }
    case "matrix_single": {
      lines.push(
        `  Type: Matrix (single answer) — return an object keyed by row ID; each value is an array containing ONE column ID for that row (the long integer "col id", NOT the label).`,
      );
      lines.push(formatMatrixRowsCols(q.raw, "scalePoints"));
      break;
    }
    case "matrix_multiple": {
      lines.push(
        `  Type: Matrix (multi answer) — return an object keyed by row ID; each value is an array of one or more column IDs for that row (the long integer "col id"s, NOT the labels).`,
      );
      lines.push(formatMatrixRowsCols(q.raw, "scalePoints"));
      break;
    }
    case "matrix_dropdown": {
      lines.push(
        `  Type: Matrix (dropdown) — return an object keyed by row ID; each value is an array containing ONE column ID for that row's dropdown (the long integer "col id", NOT the label).`,
      );
      lines.push(formatMatrixRowsCols(q.raw, "scalePoints"));
      break;
    }
    case "matrix_text": {
      lines.push(
        `  Type: Matrix (text input) — return an object keyed by row ID; each value is an object keyed by column ID with the text answer for that cell.`,
      );
      lines.push(formatMatrixRowsCols(q.raw, "scalePoints"));
      break;
    }
    case "matrix_rating": {
      const scale = q.display.scale ?? { min: 1, max: 5 };
      lines.push(
        `  Type: Matrix (rating ${scale.min}–${scale.max}) — return an object keyed by row ID; each value is an object keyed by column ID with the integer rating for that cell.`,
      );
      lines.push(formatMatrixRowsCols(q.raw, "scalePoints"));
      break;
    }
    case "group_rating": {
      const scale = q.display.scale ?? { min: 1, max: 5 };
      lines.push(
        `  Type: Group rating — return an object keyed by row ID; each value is an integer ${scale.min}–${scale.max}.`,
      );
      lines.push(formatGroupRatingRows(q.raw));
      break;
    }
    case "constant_sum": {
      const total = extractConstantSumTotal(q.raw);
      lines.push(
        `  Type: Constant sum — return an object keyed by row ID; values are integers that MUST sum to exactly ${total}.`,
      );
      lines.push(formatGroupRatingRows(q.raw));
      break;
    }
    case "text":
      lines.push(
        `  Type: Open text — write a ${verbosityHint(q)} answer in the persona's language.`,
      );
      break;
    case "number":
      lines.push(`  Type: Number — return a number.`);
      break;
    case "date":
      lines.push(`  Type: Date — return an ISO 8601 string (e.g. "2025-04-15").`);
      break;
    case "url":
      lines.push(`  Type: URL — return a full URL string starting with https://`);
      break;
    case "email":
    case "phone":
      // Should not be reached — these are non-answerable in the registry.
      // Fall through to skip.
      break;
  }
  return lines.join("\n");
}

function verbosityHint(q: RenderedQuestion): string {
  // The persona-level verbosity is the source of truth — but we don't have
  // the persona here, so we just give a generic instruction. The caller's
  // persona-block already states the verbosity setting.
  void q;
  return "complete";
}

function formatChoices(q: RenderedQuestion): string {
  const choices = q.display.choices ?? [];
  if (choices.length === 0) return "    (no options provided — leave empty)";
  return choices
    .map((c) => `    - id: ${c.id ?? "?"}, label: "${c.text}"`)
    .join("\n");
}

function formatMatrixRowsCols(q: Question, _columnKind: "scalePoints"): string {
  void _columnKind;
  const rows = extractQuestionRows(q);
  const cols = extractQuestionColumns(q);
  const rowLines = rows.map((r) => `    - row id: ${r.id}, label: "${r.label}"`);
  const colLines = cols.map((c) => `    - col id: ${c.id}, label: "${c.label}"`);
  if (rowLines.length === 0 && colLines.length === 0) {
    return "    (no rows/columns — leave empty)";
  }
  // Worked example using THIS question's actual IDs — kills the
  // label/ID confusion that bit weaker models when scale labels happen
  // to be numeric ("0", "1", ... "10"). We pick the FIRST row and the
  // MIDDLE column to give the LLM a concrete target it can copy.
  const exampleLine = (() => {
    if (rows.length === 0 || cols.length === 0) return null;
    const sampleRow = rows[0]!;
    const sampleCol = cols[Math.floor(cols.length / 2)] ?? cols[0]!;
    return `  Example for THIS question: { "${sampleRow.id}": [${sampleCol.id}] } means row "${sampleRow.label}" rated as column "${sampleCol.label}". Use these exact col id integers (not the label).`;
  })();
  return [
    "  Rows:",
    ...(rowLines.length ? rowLines : ["    (none)"]),
    "  Columns:",
    ...(colLines.length ? colLines : ["    (none)"]),
    ...(exampleLine ? [exampleLine] : []),
  ].join("\n");
}

function formatGroupRatingRows(q: Question): string {
  const rows = extractQuestionRows(q);
  const lines = rows.map((r) => `    - row id: ${r.id}, label: "${r.label}"`);
  return lines.length ? ["  Rows:", ...lines].join("\n") : "    (no rows)";
}

// ---------------------------------------------------------------------------
// Schema block — concrete output examples per type, picked from the actual
// questions so the LLM has unambiguous targets for shape.
// ---------------------------------------------------------------------------

function buildSchemaBlock(questions: RenderedQuestion[]): string {
  // Compose a sample object showing one example per distinct answer type
  // present in this survey. We use real question IDs and (for choice types)
  // real choice IDs so the LLM has zero room to invent shapes.
  const seen = new Set<AnswerType>();
  const examples: string[] = [];

  for (const q of questions) {
    if (seen.has(q.answerType)) continue;
    seen.add(q.answerType);
    const value = exampleValueFor(q);
    if (value === null) continue;
    examples.push(`    "${q.id}": ${value}`);
  }

  const exampleBody =
    examples.length > 0
      ? examples.join(",\n")
      : '    "<questionId>": <answer>';

  return `OUTPUT SCHEMA — return strictly this shape:

{
  "answers": {
${exampleBody}
  }
}

Rules per type:
- Numeric scales (NPS, CSAT, CES, rating, opinion_scale, slider, number): integer (or number for slider/number).
- Open text (text): non-empty string in the persona's language.
- Date: ISO 8601 string ("YYYY-MM-DD" or full datetime).
- URL: complete URL string.
- Yes/No: boolean (true or false).
- Single choice / Dropdown: array of EXACTLY ONE choice ID — e.g. [88].
- Multi choice: array of 1+ choice IDs — e.g. [88, 91].
- Rank order: array of ALL choice IDs in ranked order — first = highest rank.
- Matrix (single answer / dropdown): object { "<rowId>": <chosenId>, ... }.
- Matrix (multi answer): object { "<rowId>": [<chosenIds>], ... }.
- Matrix (text): object { "<rowId>": { "<colId>": "<text>", ... }, ... }.
- Matrix (rating): object { "<rowId>": { "<colId>": <int>, ... }, ... }.
- Group rating: object { "<rowId>": <int>, ... } — one rating per row.
- Constant sum: object { "<rowId>": <int>, ... } — values must sum to the configured total.

Use the exact question IDs from the list above as keys. Do NOT include questions that aren't in the list.`;
}

function exampleValueFor(q: RenderedQuestion): string | null {
  switch (q.answerType) {
    case "nps":
      return "9";
    case "csat":
      return "4";
    case "ces":
      return "5";
    case "rating":
    case "opinion_scale":
    case "slider": {
      const scale =
        q.answerType === "opinion_scale" ? resolveScale(q.raw, 0, 10)
        : q.answerType === "slider" ? resolveScale(q.raw, 0, 100)
        : resolveScale(q.raw, 1, 5);
      return String(Math.round((scale.min + scale.max) / 2));
    }
    case "yes_no":
      return "true";
    case "single_choice":
    case "dropdown": {
      const id = q.display.choices?.[0]?.id;
      return id != null ? `[${id}]` : `[<choiceId>]`;
    }
    case "multi_choice": {
      const ids = (q.display.choices ?? []).slice(0, 2).map((c) => c.id).filter((x): x is number => typeof x === "number");
      return ids.length > 0 ? `[${ids.join(", ")}]` : `[<choiceId>, <choiceId>]`;
    }
    case "ranking": {
      const ids = (q.display.choices ?? []).map((c) => c.id).filter((x): x is number => typeof x === "number");
      return ids.length > 0 ? `[${ids.join(", ")}]` : `[<allChoiceIds>]`;
    }
    case "matrix_single":
    case "matrix_dropdown":
    case "group_rating":
      return `{ "<rowId>": <id-or-int>, ... }`;
    case "matrix_multiple":
      return `{ "<rowId>": [<id>, <id>], ... }`;
    case "matrix_text":
      return `{ "<rowId>": { "<colId>": "<text>" }, ... }`;
    case "matrix_rating":
      return `{ "<rowId>": { "<colId>": <int> }, ... }`;
    case "constant_sum":
      return `{ "<rowId>": <int>, ... }  // sums to total`;
    case "text":
      return `"open-text answer in the persona's language"`;
    case "number":
      return "42";
    case "date":
      return `"2025-04-15"`;
    case "url":
      return `"https://example.com"`;
    case "email":
    case "phone":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Question type → AnswerType mapping
// ---------------------------------------------------------------------------

/**
 * Infer the internal `AnswerType` from a SS Question.
 * Returns null for non-answerable types — the caller skips those.
 *
 * Exported because the validator and the orchestrator both need this map.
 */
export function inferAnswerType(
  q: Question,
  meta?: QuestionTypeMeta,
): AnswerType | null {
  const m = meta ?? getQuestionTypeMeta(q.type);
  if (!m.answerable) return null;

  switch (m.canonical) {
    case "nps":
      return "nps";
    case "csat":
      return "csat";
    case "ces":
      return "ces";
    case "opinionscale":
      return "opinion_scale";
    case "rating":
    case "smiley":
      return "rating";
    case "slider":
      return "slider";
    case "grouprating":
    case "group_rating":
    case "groupratingscale":
      return "group_rating";

    case "yesno":
      return "yes_no";

    case "multichoice":
    case "multipleansweroptions":
    case "picturechoice":
    case "imagechoice":
      return isMultipleAnswers(q) ? "multi_choice" : "single_choice";
    case "radiochoice":
    case "radio":
    case "singlechoice":
      return "single_choice";
    case "dropdown":
    case "select":
      return "dropdown";

    case "rankorder":
    case "ranking":
      return "ranking";
    case "constantsum":
    case "constsum":
      return "constant_sum";

    case "matrix":
    case "matrixgrid":
      return matrixSubtype(q);

    case "textinput":
    case "text":
    case "longtext":
    case "shorttext":
    case "comment":
    // Score-follow-up questions (NPSFeedback / CSATFeedback / CESFeedback):
    // these are open-text follow-ups to a parent rating question. SS
    // requires the answer entry to carry `parent_question_id` pointing at
    // the parent score question — the response-builder reads that from
    // the question metadata at push time.
    case "npsfeedback":
    case "csatfeedback":
    case "cesfeedback":
      return "text";
    case "number":
    case "numeric":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "url":
    case "website":
    case "link":
      return "url";

    default:
      // Unknown but answerable per registry — fall back to text. The
      // validator is permissive enough that this stays usable.
      return "text";
  }
}

function isMultipleAnswers(q: Question): boolean {
  // SS uses `multiple_answers: true` on the question for multi-select.
  const v = (q as unknown as { multiple_answers?: unknown }).multiple_answers;
  return v === true;
}

function matrixSubtype(q: Question): AnswerType {
  const data = q.properties?.data;
  if (!data || typeof data !== "object") return "matrix_single";
  const t = (data as Record<string, unknown>).type;
  if (typeof t !== "string") return "matrix_single";
  switch (t.toUpperCase()) {
    case "MULTIPLE_ANSWER":
      return "matrix_multiple";
    case "DROP_DOWN":
    case "DROPDOWN":
      return "matrix_dropdown";
    case "TEXT_INPUT":
    case "TEXT":
      return "matrix_text";
    case "RATING":
      return "matrix_rating";
    case "SINGLE_ANSWER":
    default:
      return "matrix_single";
  }
}

// ---------------------------------------------------------------------------
// Field probes — kept tolerant since SS surfaces config in slightly different
// places per question type / workspace plan.
// ---------------------------------------------------------------------------

function extractScaleLabels(q: Question): { min?: string; max?: string } {
  const data = q.properties?.data;
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  return {
    min: typeof d.min === "string" ? d.min : undefined,
    max: typeof d.max === "string" ? d.max : undefined,
  };
}

function extractMultiChoiceRange(q: Question): string | null {
  const data = q.properties?.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "EXACT" && typeof d.exactChoices === "number") {
    return `exactly ${d.exactChoices}`;
  }
  if (d.type === "RANGE" && typeof d.minLimit === "number" && typeof d.maxLimit === "number") {
    return `between ${d.minLimit} and ${d.maxLimit}`;
  }
  return null;
}

function extractConstantSumTotal(q: Question): number {
  const data = q.properties?.data;
  if (!data || typeof data !== "object") return 100;
  const d = data as Record<string, unknown>;
  return typeof d.total_sum === "number" ? d.total_sum : 100;
}

// (Removed local parsePosition; replaced by compareQuestionPositions in
// lib/surveysparrow/types.ts which correctly handles section ordering.)

// ---------------------------------------------------------------------------
// Display-logic prompt description (phase: display-logic-respect)
// ---------------------------------------------------------------------------
//
// Render a question's display_logic as a one-liner the LLM can interpret
// against the persona it's playing. The goal isn't formal correctness —
// the validator's evaluator is the source of truth for whether a question
// is shown. The goal here is to tell the LLM "you don't need to answer
// this for Promoters" up front so it doesn't waste tokens trying.
//
// Examples:
//   - Q3 includes choice "Yes, I attended a show" (id=1234)
//   - Q5 ≤ 6 AND Q7 includes choice "Service" (id=789)
//   - variable loyalty_tier equals "Gold"

function describeDisplayLogic(
  logic: Question["display_logic"],
  questionsById: Map<number, RenderedQuestion>,
): string | null {
  if (!logic?.logics || logic.logics.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < logic.logics.length; i++) {
    const c = logic.logics[i]!;
    if (i > 0) {
      parts.push(c.join_condition === "or" ? " OR " : " AND ");
    }
    parts.push(describeCondition(c, questionsById));
  }
  return parts.join("");
}

function describeCondition(
  c: NonNullable<NonNullable<Question["display_logic"]>["logics"]>[number],
  questionsById: Map<number, RenderedQuestion>,
): string {
  if (c.type === "variable") {
    const v = c.variable_name ?? c.variable_id ?? "?";
    if (c.comparator === "isAnswered") return `variable ${v} is set`;
    if (c.comparator === "isNotAnswered") return `variable ${v} is empty`;
    return `variable ${v} ${humanComparator(c.comparator)} ${JSON.stringify(c.value ?? "")}`;
  }
  // type === "question"
  const qid = c.question_id ?? 0;
  const upstream = questionsById.get(qid);
  const ref = upstream ? `Q${upstream.position}` : `question id=${qid}`;
  switch (c.comparator) {
    case "isSelected": {
      if (c.choice_id != null) {
        const choiceText = upstream?.display.choices?.find((ch) => ch.id === c.choice_id)?.text;
        return choiceText
          ? `${ref} includes choice "${choiceText}" (id=${c.choice_id})`
          : `${ref} includes choice id=${c.choice_id}`;
      }
      return `${ref} has a selection`;
    }
    case "isNotSelected": {
      if (c.choice_id != null) {
        const choiceText = upstream?.display.choices?.find((ch) => ch.id === c.choice_id)?.text;
        return choiceText
          ? `${ref} does NOT include choice "${choiceText}" (id=${c.choice_id})`
          : `${ref} does NOT include choice id=${c.choice_id}`;
      }
      return `${ref} has no selection`;
    }
    case "isAnswered":
      return `${ref} is answered`;
    case "isNotAnswered":
      return `${ref} is not answered`;
    default:
      return `${ref} ${humanComparator(c.comparator)} ${JSON.stringify(c.value ?? "")}`;
  }
}

function humanComparator(c: string): string {
  switch (c) {
    case "equals": return "=";
    case "notEquals": return "≠";
    case "greaterThan": return ">";
    case "lessThan": return "<";
    case "greaterThanOrEqual": return "≥";
    case "lessThanOrEqual": return "≤";
    case "contains": return "contains";
    case "doesNotContain": return "does NOT contain";
    case "startsWith": return "starts with";
    case "endsWith": return "ends with";
    default: return c;
  }
}
