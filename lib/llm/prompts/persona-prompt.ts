// Prompt construction for Phase 4 persona synthesis.
//
// We send the LLM only what it needs to generate the personality fields:
//   - sentimentArchetype (already pre-assigned, but we ask the LLM to confirm
//     it so it stays committed in the rest of its output)
//   - keyConcerns: 3-5 strings, varied per persona
//   - themesTouched: subset of configured theme labels (2-3)
//   - verbosity: terse / medium / verbose
//   - demographicNotes: one-sentence flavor
//
// The LLM does NOT generate names, emails, locations, or device profiles —
// those are all Faker-generated upstream. Sending them in just leaks
// unnecessary tokens. We DO send the persona's pre-assigned sentiment +
// language + country so the model can tailor the personality to the
// demographic.

import type { ProfileDraft, ThemeConfig } from "@/lib/profiles/types";
import type { Persona } from "@/lib/generation/persona-types";

// ---------------------------------------------------------------------------
// Survey context (what the LLM needs to know about the survey)
// ---------------------------------------------------------------------------

export interface SurveyContext {
  surveyName: string;
  surveyDescription?: string;
  /** Free-form text from the Configure -> Context section. */
  useCase: string;
  themes: ThemeConfig[];
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are generating synthetic survey respondent personas for a product demo.
Each persona represents a realistic customer who will answer a survey.

Your output must be valid JSON matching the schema exactly. No markdown, no explanation, no preamble — pure JSON only.

The personas should feel like distinct real people — varied in their concerns, communication style, and relationship with the product.
Do not make all personas sound the same. Vary their level of frustration, enthusiasm, and engagement based on their assigned sentiment archetype.`;

interface PromptInput {
  /** The slice of personas this prompt covers (one batch). */
  batch: Persona[];
  draft: ProfileDraft;
  surveyContext: SurveyContext;
  /** If retrying after a parse / validation failure, include the prior error. */
  retryReason?: string;
}

export interface PromptResult {
  systemPrompt: string;
  userPrompt: string;
  /** Convenience for the LLM call layer. */
  expectedCount: number;
}

export function buildPersonaPrompt(input: PromptInput): PromptResult {
  const { batch, draft, surveyContext, retryReason } = input;
  const distribution = draft.personaDistribution;

  const themeBlock =
    surveyContext.themes.length > 0
      ? surveyContext.themes
          .map((t) => `- ${t.label} (weight: ${t.weight})`)
          .join("\n")
      : "(no themes configured — use generic product-related concerns)";

  const personaBlock = batch
    .map((p) => {
      const lang = p.language;
      const country = p.countryName;
      return `Persona ${p.index}: ${p.sentimentArchetype} | language=${lang} | country=${country}`;
    })
    .join("\n");

  const retryBlock = retryReason
    ? `\n\nIMPORTANT: A previous attempt failed validation with: "${retryReason}". Make sure your output is strictly valid JSON matching the schema below.\n`
    : "";

  const userPrompt = `Generate ${batch.length} persona personality profiles for this survey context:

COMPANY/USE CASE:
${surveyContext.useCase || "(not provided — use generic SaaS product context)"}

SURVEY: "${surveyContext.surveyName}"${surveyContext.surveyDescription ? `\nDescription: ${surveyContext.surveyDescription}` : ""}

PERSONA DISTRIBUTION (the assignments are already set per persona below — do NOT redistribute):
- Promoters (${distribution.promoter}%): Satisfied, likely to recommend, positive experience
- Passives (${distribution.passive}%): Neutral, mixed experience, neither very happy nor unhappy
- Detractors (${distribution.detractor}%): Dissatisfied, have specific complaints, low scores

THEMES TO WEAVE IN (assign 2-3 per persona, not all to every persona — pick by relevance to the persona's archetype and demographic):
${themeBlock}

PRE-ASSIGNED PERSONA DATA (do NOT generate names, emails, or demographics — those are already set):
${personaBlock}

For each persona, return ONLY:
- sentimentArchetype: "promoter" | "passive" | "detractor" (must match the assignment above)
- keyConcerns: array of 3-5 short strings (specific concerns, opinions, or points of view this person has — phrased as bullet topics, not full sentences)
- themesTouched: array of 2-3 theme labels from the list above (use the exact label text)
- verbosity: "terse" | "medium" | "verbose" (how wordy this persona is in open-text answers)
- demographicNotes: one short sentence describing this persona's context (role, life situation, or relationship to the product). Max 150 characters.

Output schema:
{
  "personas": [
    {
      "sentimentArchetype": "...",
      "keyConcerns": ["...", "...", "..."],
      "themesTouched": ["...", "..."],
      "verbosity": "...",
      "demographicNotes": "..."
    }
  ]
}

Return JSON with exactly ${batch.length} personas in the array, in the same order as the persona list above.${retryBlock}`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    expectedCount: batch.length,
  };
}
