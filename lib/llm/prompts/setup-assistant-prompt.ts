// Phase 8 — Setup Assistant prompt builder.
//
// This is the file the SE will care about most when tuning output
// quality. The model is asked to produce a tightly-scoped JSON object
// with three creative fields:
//
//   1. context  — a polished 2-3 sentence demo brief, grounded in the
//                 selected survey + company.
//   2. themes   — 4-8 weighted themes drawn from the survey questions,
//                 choices, and company context.
//   3. customVariables — 3-6 STRING-typed variables that would enrich
//                        a demo without duplicating SS workspace vars
//                        or the user's existing draft.
//
// Persona distribution, timing, metadata are all deterministic and
// handled outside this prompt (see lib/generation/setup-assistant-types.ts).
//
// We deliberately do NOT ask the model to browse the web or invent
// information about the company. The system prompt tells it to use
// general public knowledge OR ground in the inputs only.

import type { SetupAssistantRequest, SentimentShape } from "@/lib/generation/setup-assistant-types";

export interface BuildSetupPromptResult {
  systemPrompt: string;
  userPrompt: string;
  /** Convenience: same identifier the route uses for logging. */
  contextLabel: string;
}

/**
 * Optional research material injected ahead of the directives. May come
 * from:
 *   - the model's own web_search tool use (then it's effectively the
 *     model's own working notes — we omit this block and add a
 *     "research first if needed" directive)
 *   - a server-side homepage fetch (then we inject the cleaned text)
 *   - nothing (LLM works from inputs alone)
 */
export interface PromptResearchContext {
  /** Already-fetched company notes — inject verbatim. */
  researchBlock?: string;
  /** True when the LLM has live web_search available in this call. */
  hasWebSearchTool?: boolean;
}

const SYSTEM_PROMPT = `You are a demo-prep assistant for SurveySparrow's GTM team. You help solutions engineers configure realistic demo data for prospect surveys.

CRITICAL RULES:
1. Your output must be valid JSON, nothing else. No markdown fences, no prose before or after.
2. Ground every suggestion in the supplied survey + company. Avoid generic phrasing.
3. The "context" paragraph must be specific to THIS company + THIS survey. Never write filler like "Improve customer satisfaction and collect feedback."
4. Themes must come from the survey questions, choices, and company use case. Each theme is something the synthetic respondents will actually talk about in open-text answers.
5. Custom variables must be useful for THIS company. Avoid duplicating identifiers in "existingCustomVariableIdentifiers" or "surveySparrowVariableNames".
6. Use general public knowledge of the company name + website. Do not invent specific products, executives, customer counts, or financial details.

OUTPUT SCHEMA — return strictly this JSON shape:

{
  "context": "2-3 sentence demo brief tailored to the company + survey. Specific, not generic.",
  "themes": [
    { "label": "Theme name (1-4 words)", "weight": 25, "reason": "Why this theme matters for this survey." }
  ],
  "customVariables": [
    // STRING (default — segments, tiers, statuses, named entities):
    {
      "label": "Customer Tier",
      "apiIdentifier": "customer_tier",
      "type": "STRING",
      "source": "surveysparrow_variable",
      "options": [{ "text": "Enterprise", "weight": 40 }, { "text": "Growth", "weight": 35 }],
      "reason": "Why this variable enriches the demo."
    },
    // NUMBER (counts, amounts, scores — use ONLY when the field is genuinely numeric):
    {
      "label": "Purchase Amount",
      "apiIdentifier": "purchase_amount",
      "type": "NUMBER",
      "numberConfig": { "mode": "range", "min": 25, "max": 1500, "allowDecimals": true, "decimalPlaces": 2 },
      "reason": "Order total tied to this submission."
    },
    // DATE (transaction date, signup date — always emitted as YYYY-MM-DD):
    {
      "label": "Order Date",
      "apiIdentifier": "order_date",
      "type": "DATE",
      "dateConfig": { "mode": "relative", "relativeDays": 60 },
      "reason": "When the order was placed."
    }
  ],
  "warnings": []
}

CONSTRAINTS:
- "context": 2-3 sentences, 220-400 characters. No marketing flourish, no exclamation marks.
- "themes": between 4 and 8 entries. Each label is 1-4 words. Each weight is an integer 5-40. Weights are RELATIVE — they don't need to sum to 100.
- "customVariables": up to 24 entries — covers existing SS workspace variables (enriched) PLUS up to 4 new AI-suggested ones. apiIdentifier must be snake_case, lowercase letters and digits and underscores, start with a letter, max 35 chars.
  - STRING: 2-5 options. Option text must be grounded in the company / survey context — NEVER use "Sample value A", "Option 1", "Placeholder", "Value 1" or similar fillers; the validator rejects those. Option weights are integers 5-95 and should roughly sum to ~100 for readability (not enforced).
  - NUMBER: include "numberConfig" — mode "range" needs min<max; mode "static" needs staticValue. allowDecimals=true only for currency/measurements/scores; leave it false for counts and IDs. decimalPlaces is 1-4 (default 2).
  - DATE: include "dateConfig" — mode "relative" with relativeDays 1-365, OR "range" with start+end as YYYY-MM-DD strings. Dates are always shipped to SurveySparrow as YYYY-MM-DD.
- Default to STRING. Use NUMBER or DATE only when the variable's natural type clearly demands it.
- "warnings": optional array of short strings if you had to skip or rename things.`;

export function buildSetupAssistantPrompt(
  req: SetupAssistantRequest,
  research?: PromptResearchContext,
): BuildSetupPromptResult {
  const { inputs, survey, existing, surveySparrowVariables } = req;

  const companyBlock = `COMPANY
Name: ${inputs.companyName}
${inputs.companyWebsite ? `Website: ${inputs.companyWebsite}` : "Website: (not supplied)"}
Sentiment shape for this demo: ${inputs.sentimentShape} (${describeShape(inputs.sentimentShape)})
${inputs.notes ? `Notes from the SE: ${inputs.notes}` : "No additional notes."}`;

  // Trim to 30 questions to bound the prompt — beyond that we lose
  // marginal grounding but blow the budget.
  const trimmedQuestions = survey.questions.slice(0, 30);
  const questionsBlock = trimmedQuestions
    .map((q, i) => {
      const choiceText = q.choices && q.choices.length > 0
        ? "\n      Choices: " + q.choices.map((c) => `"${c.text}"`).join(", ").slice(0, 240)
        : "";
      return `  Q${q.position || i + 1} (${q.type}): ${q.text}${q.required ? " [REQUIRED]" : ""}${choiceText}`;
    })
    .join("\n");
  const truncatedNote = survey.questions.length > 30
    ? `\n  (Showing 30 of ${survey.questions.length} questions — the rest follow similar patterns.)`
    : "";

  const surveyBlock = `SURVEY
Name: ${survey.name}
Type: ${survey.type}
Questions (${trimmedQuestions.length} shown):
${questionsBlock}${truncatedNote}`;

  const existingBlock = existing
    ? `EXISTING DRAFT (already in the user's configuration — do not duplicate)
useCase: ${existing.useCase ? `"${truncate(existing.useCase, 300)}"` : "(empty)"}
existingCustomVariableIdentifiers: ${
        existing.customVariableIdentifiers && existing.customVariableIdentifiers.length > 0
          ? existing.customVariableIdentifiers.join(", ")
          : "(none)"
      }`
    : "EXISTING DRAFT: (nothing configured yet)";

  // Updated 8d: instead of asking the model to SKIP existing SS variables,
  // we now ask it to ENRICH them. Each variable in the list below should
  // appear in `customVariables` with realistic options grounded in the
  // company + survey context. Source defaults to "surveysparrow_variable"
  // for these (the dialog uses this to skip creating them at push time).
  const ssVarsBlock = surveySparrowVariables && surveySparrowVariables.length > 0
    ? `SURVEYSPARROW WORKSPACE VARIABLES (these already exist — enrich them with realistic option values):
For EACH variable below, include it in your customVariables output with:
  • EXACTLY the same apiIdentifier (e.g. "customer_role" stays "customer_role" — don't rename)
  • source: "surveysparrow_variable"
  • 2-5 option values tailored to ${inputs.companyName} and this survey (NOT "Sample value A", NOT "Option 1")
  • A brief reason explaining why those options fit
If the variable's purpose is unclear (e.g. internal IDs like assigned_agent_id), provide 2-3 plausible domain values (e.g. "Agent-1001", "Agent-1002") — still never use placeholders like "Sample A".

${surveySparrowVariables
  .slice(0, 30)
  .map((v) => `  - name: ${v.name}${v.label ? ` (label: "${v.label}")` : ""}${v.type ? ` [${v.type}]` : ""}${v.description ? ` — ${v.description}` : ""}`)
  .join("\n")}

You MAY also add up to 4 NEW custom variables (use source: "ai_suggested") that would enrich the demo beyond the SS workspace list. Don't repeat any apiIdentifier above.`
    : "SURVEYSPARROW WORKSPACE VARIABLES: (none fetched — produce 3-6 AI-suggested variables instead, source: \"ai_suggested\")";

  const researchSection = research?.researchBlock?.trim()
    ? research.researchBlock.trim()
    : "";

  // Tool-aware directive — the model gets two different "research" prompts
  // depending on whether it has web_search available in this call.
  const researchDirective = research?.hasWebSearchTool
    ? `Before producing the JSON, use the web_search tool (up to 5 queries) to research the company. Look up what they make, who their customers are, and any obvious product categories. If the company is too small or unknown to find, proceed with the user's inputs.
CRITICAL: after any web searches, your FINAL message must be ONLY the JSON object — no preamble, no "Based on my research…", no commentary before or after. Start the message with "{" and end it with "}". Do not narrate what you found.`
    : researchSection
      ? `Use the COMPANY RESEARCH NOTES above as your ground truth for what the company does. Do not invent product names or facts beyond what's in the notes + inputs.`
      : `You do not have live research for this company. Infer cautiously from the company name + website + survey questions. Avoid specifics you can't justify from these inputs.`;

  const directives = `INSTRUCTIONS:
- ${researchDirective}
- Produce a JSON object matching the OUTPUT SCHEMA exactly.
- The "context" paragraph reads as a brief to a demo-generator tool: who is being simulated, what experience is being measured, what story should the data support. Concrete. Skip the company's marketing language.
- For "themes", pick the most reachable narratives from the survey questions. Example for a post-purchase survey: "product quality", "delivery experience", "setup friction", "support response", "value for money". Use the company context to colour the labels (e.g. for a smart-home company, "device pairing" beats "setup friction").
- For "customVariables", suggest fields that would be PASSED IN as response context (segments, tiers, locations, product lines). Avoid recreating obvious workspace variables like "full_name" or "email" — those are populated automatically.
- If the survey looks generic (no choices, no specifics), still tailor the output to the COMPANY by inferring its likely product or service from the name, website, notes, and (when available) the research.

Return ONLY the JSON object.`;

  const userPrompt = [
    companyBlock,
    "---",
    surveyBlock,
    "---",
    existingBlock,
    "---",
    ssVarsBlock,
    ...(researchSection ? ["---", researchSection] : []),
    "---",
    directives,
  ].join("\n\n");

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    contextLabel: `setup-assistant-${slugify(inputs.companyName).slice(0, 20)}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeShape(shape: SentimentShape): string {
  switch (shape) {
    case "mostly_positive":
      return "promoter-heavy (~70% promoters)";
    case "balanced":
      return "balanced (~55/25/20)";
    case "recovery":
      return "detractor-heavy (~25/30/45) — service recovery / churn story";
    case "polarized":
      return "polarized promoter+detractor with few passives (~45/10/45)";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
