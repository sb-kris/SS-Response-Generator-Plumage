// Rotating loading-message pools for the long-running phases of Plumage.
//
// Tone: warm and a little cheeky — never trying too hard. Reads naturally
// out loud. Avoid lines that would sound weird in a customer-facing demo
// recording. The personality is on the dev/internal side of the line.
//
// Pools rotate every 2.5s via <RotatingLoadingMessage />. Each pool is
// shuffled at pick time so the user doesn't see them in lockstep order
// run after run.

export const PERSONA_SYNTHESIS_MESSAGES = [
  "Hatching personas...",
  "Teaching Sofia how to complain about pricing...",
  "Assigning concerns and quirks...",
  "Drawing avatars from the aether...",
  "Convincing skeptics they exist...",
  "Wiring up sentiment archetypes...",
  "Distributing personalities across continents...",
  "Picking emails — no one gets 'admin@'...",
  "Whispering use cases to the LLM...",
];

export const RESPONSE_GENERATION_MESSAGES = [
  "Asking Marcus what he really thinks...",
  "Channeling Priya's frustration with the app...",
  "Coaxing thoughtful feedback out of Promoters...",
  "Convincing detractors to elaborate...",
  "Drafting open-text replies in 3 languages...",
  "Matching ratings to personalities...",
  "Translating discontent into NPS scores...",
  "Persuading personas to fill out your survey...",
  "Feathering the dataset...",
];

export const PUSH_MESSAGES = [
  "Knocking on SurveySparrow's door...",
  "Threading responses through the API...",
  "Asking nicely if SS will accept these...",
  "Tagging responses for later cleanup...",
  "Delivering responses by carrier sparrow...",
];

// Rare easter-egg messages — sprinkled in at low probability (~2% of picks).
// Don't make them too funny; the joke wears thin if it lands too often.
export const RARE_MESSAGES = [
  "Asking the LLM nicely...",
  "Bribing the API with cookies...",
  "Convincing tokens to behave...",
  "Reminding the model what 'concise' means...",
];

const RARE_CHANCE = 0.02;

/**
 * Pick a random message from a pool. With low probability, returns a rare
 * easter-egg line instead. Deterministically random per call — no state.
 */
export function pickLoadingMessage(pool: string[]): string {
  if (pool.length === 0) return "Working...";
  if (Math.random() < RARE_CHANCE && RARE_MESSAGES.length > 0) {
    return RARE_MESSAGES[Math.floor(Math.random() * RARE_MESSAGES.length)]!;
  }
  return pool[Math.floor(Math.random() * pool.length)]!;
}
