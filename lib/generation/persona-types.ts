// Phase 4 — Persona schema.
//
// A `Persona` is the unit of input to Phase 5 (response generation). Most fields
// are deterministic (Faker-generated names, cities, device profiles, timestamps)
// — the LLM only contributes the small "personality" subset
// (`sentimentArchetype`, `keyConcerns`, `themesTouched`, `verbosity`,
// `demographicNotes`). This keeps LLM calls cheap and fast while ensuring
// names/locations are realistic.
//
// SECURITY: personas may be inspected and previewed in the UI but MUST NOT
// be persisted with credentials. The personas-store uses sessionStorage and
// holds no secret data.

export type SentimentArchetype = "promoter" | "passive" | "detractor";
export type Verbosity = "terse" | "medium" | "verbose";
export type DeviceType = "Mobile" | "Desktop" | "Tablet";

export interface Persona {
  /** Stable uuid — used as DiceBear avatar seed and for keying lists. */
  id: string;
  /** 1-based, for progress display and table numbering. */
  index: number;

  // ---- Identity (Faker-generated, pre-LLM) ----
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;

  // ---- Geography (from language-geography.ts mapping) ----
  language: string; // ISO 639-1 lowercase, e.g. "en", "es"
  country: string; // ISO 3166-1 alpha-2 uppercase, e.g. "US", "BR"
  countryName: string;
  city: string;
  region: string; // state / province (best-effort, may be empty)
  timezone: string; // IANA, e.g. "America/New_York"
  latitude: number;
  longitude: number;

  // ---- Device profile ----
  deviceType: DeviceType;
  browser: string;
  os: string;
  userAgent: string;

  // ---- Submission metadata ----
  submittedAt: string; // ISO datetime — driven by timing distribution
  ipAddress: string | null; // null if ip mode is "none"

  // ---- LLM-generated personality ----
  sentimentArchetype: SentimentArchetype;
  keyConcerns: string[]; // 3-5 concerns relevant to this persona
  themesTouched: string[]; // subset of configured theme labels
  verbosity: Verbosity;
  demographicNotes: string; // one-sentence flavor

  // ---- Resolved custom variable values ----
  /** Keyed by the variable's `apiIdentifier` (snake_case), value is string|number. */
  variableValues: Record<string, string | number>;
}

/** What the LLM returns per persona — the small subset it actually generates. */
export interface PersonaLLMOutput {
  sentimentArchetype: SentimentArchetype;
  keyConcerns: string[];
  themesTouched: string[];
  verbosity: Verbosity;
  demographicNotes: string;
}

/** Aggregate stats for the post-synthesis summary card. */
export interface PersonaSummary {
  total: number;
  bySentiment: Record<SentimentArchetype, number>;
  byLanguage: Record<string, number>;
  topConcerns: Array<{ concern: string; count: number }>;
}

export function summarizePersonas(personas: Persona[]): PersonaSummary {
  const bySentiment: Record<SentimentArchetype, number> = {
    promoter: 0,
    passive: 0,
    detractor: 0,
  };
  const byLanguage: Record<string, number> = {};
  const concernCounts = new Map<string, number>();

  for (const p of personas) {
    bySentiment[p.sentimentArchetype] = (bySentiment[p.sentimentArchetype] ?? 0) + 1;
    byLanguage[p.language] = (byLanguage[p.language] ?? 0) + 1;
    for (const concern of p.keyConcerns) {
      const k = concern.trim().toLowerCase();
      if (!k) continue;
      concernCounts.set(k, (concernCounts.get(k) ?? 0) + 1);
    }
  }

  const topConcerns = [...concernCounts.entries()]
    .map(([concern, count]) => ({ concern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    total: personas.length,
    bySentiment,
    byLanguage,
    topConcerns,
  };
}
