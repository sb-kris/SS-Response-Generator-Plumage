// Faker-based pre-LLM persona generation.
//
// Builds the deterministic parts of every persona — name, email, phone,
// city, timezone, device profile, IP, custom variable values, submission
// timestamp — before the LLM is even called. The LLM only contributes the
// personality subset (sentiment, concerns, themes, verbosity, demographic
// notes). Two-phase by design: it keeps LLM calls cheap, ensures realistic
// names/locations, and lets us regenerate just the LLM half if needed.
//
// SECURITY: never include credentials in persona output. This module is
// purely transformative — config in, structured persona out.

import { Faker, allLocales, type LocaleDefinition } from "@faker-js/faker";
import type {
  CountryFilterEntry,
  CustomVariable,
  LanguageWeight,
  PersonaDistribution,
  ProfileDraft,
  SystemMetadataConfig,
  TimeRangeConfig,
} from "@/lib/profiles/types";
import { LANGUAGES_BY_CODE, type LanguageCountry } from "@/lib/utils/language-geography";
import { getCityCoordinates } from "@/lib/utils/city-coordinates";
import { buildUserAgent } from "@/lib/utils/user-agent-builder";
import type {
  Persona,
  SentimentArchetype,
  DeviceType,
} from "./persona-types";
import { generateTimestamps } from "./time-distribution";

// ---------------------------------------------------------------------------
// Faker locale resolution
// ---------------------------------------------------------------------------

// Faker exports `allLocales` keyed by the locale string ("en_US", "fr_CA",
// etc). When we ask for a locale that doesn't exist, we fall back through
// language-only → "en" → base locale. Faker requires `en` and `base` in the
// chain because some functions live there.
function resolveFaker(localeRequest: string): Faker {
  const candidates: string[] = [];
  if (localeRequest) candidates.push(localeRequest);
  // Try the language-level fallback (e.g. "fr_CA" -> "fr").
  const langOnly = localeRequest.split("_")[0];
  if (langOnly && langOnly !== localeRequest) candidates.push(langOnly);
  candidates.push("en", "base");

  const locales = candidates
    .map((c) => allLocales[c as keyof typeof allLocales])
    .filter((l): l is LocaleDefinition => Boolean(l));
  // Faker dedupes via the chain order — first hit wins for each property.
  return new Faker({ locale: locales });
}

// ---------------------------------------------------------------------------
// Identity (name, email, phone)
// ---------------------------------------------------------------------------

const EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "protonmail.com",
  "hotmail.com",
];

interface PersonaIdentity {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
}

function asciiSlug(input: string): string {
  // Strip diacritics, lowercase, drop non-alphanumerics. Used to build emails
  // that look natural even when the persona's actual name has accents.
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function generateIdentity(
  faker: Faker,
  country: LanguageCountry,
  rng: () => number,
): PersonaIdentity {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const name = `${firstName} ${lastName}`.trim();

  // Build a name-based email. Faker's `internet.email()` emits domains like
  // "Stoltenberg.biz" which are obviously fake, so we roll our own.
  const localBase = `${asciiSlug(firstName)}.${asciiSlug(lastName)}`.replace(/^\.+|\.+$/g, "");
  // Some personas get a short suffix (numbers / initials) to avoid collisions
  // and match real-world variety.
  const localSuffix = rng() < 0.3 ? String(Math.floor(rng() * 99) + 1) : "";
  const local = (localBase || "user") + localSuffix;
  const domain = EMAIL_DOMAINS[Math.floor(rng() * EMAIL_DOMAINS.length)] ?? "gmail.com";
  const email = `${local}@${domain}`;

  // `phoneFormat` uses `#` for digits.
  const phone = country.phoneFormat.replace(/#/g, () => String(Math.floor(rng() * 10)));

  return { firstName, lastName, name, email, phone };
}

// ---------------------------------------------------------------------------
// Geography (assign country + city + timezone from language)
// ---------------------------------------------------------------------------

interface LocationData {
  country: string;
  countryName: string;
  city: string;
  region: string;
  timezone: string;
  latitude: number;
  longitude: number;
  /** Language-specific Faker locale string for this country. */
  fakerLocale: string;
  /** Phone format string carried through so identity can use it. */
  phoneFormat: string;
}

// Build a global country lookup from all language definitions — used when
// the country filter names a country that isn't in a language's own list
// (e.g. French persona assigned to United States). Built once at module
// load time; the source data is static.
const GLOBAL_COUNTRY_MAP: Map<string, LanguageCountry> = (() => {
  const map = new Map<string, LanguageCountry>();
  for (const langDef of Object.values(LANGUAGES_BY_CODE)) {
    for (const c of langDef.countries) {
      if (!map.has(c.code)) map.set(c.code, c);
    }
  }
  return map;
})();

function assignLocation(
  languageCode: string,
  countryFilter: CountryFilterEntry[],
  rng: () => number,
): LocationData {
  const lang = LANGUAGES_BY_CODE[languageCode];
  if (!lang) {
    // Defensive — shouldn't happen because the UI only allows registered languages.
    return {
      country: "US",
      countryName: "United States",
      city: "New York",
      region: "",
      timezone: "America/New_York",
      latitude: 40.71,
      longitude: -74.0,
      fakerLocale: "en_US",
      phoneFormat: "+1 (###) ###-####",
    };
  }

  if (countryFilter.length > 0) {
    const filterMap = new Map(countryFilter.map((e) => [e.code, e.weight]));

    // Happy path: language has countries that match the filter — use them
    // with the filter's weights so the chosen countries are honoured.
    const intersected = lang.countries
      .filter((c) => filterMap.has(c.code))
      .map((c) => ({ ...c, weight: filterMap.get(c.code) ?? c.weight }));

    if (intersected.length > 0) {
      const country = weightedPick(intersected, (c) => c.weight, rng);
      return buildLocationFromCountry(country, country.fakerLocale ?? lang.fakerLocale, rng);
    }

    // No intersection: the language has no native countries inside the filter
    // (e.g. French + US-only filter). Still honour the filter — pick from the
    // filter list and look up geographic data (timezone, cities, phone) from
    // the global country registry. Preserve the language's fakerLocale so the
    // persona still gets authentic names in their assigned language.
    const picked = weightedPick(countryFilter, (e) => e.weight, rng);
    const geoData = GLOBAL_COUNTRY_MAP.get(picked.code);
    if (geoData) {
      return buildLocationFromCountry(geoData, lang.fakerLocale, rng);
    }
    // Filter country not found in the global registry (unknown code) — fall
    // through to the language's full distribution below.
  }

  // No filter active, or filter country unknown: use the language's
  // full weighted country list.
  const country = weightedPick(lang.countries, (c) => c.weight, rng);
  return buildLocationFromCountry(country, country.fakerLocale ?? lang.fakerLocale, rng);
}

/** Shared helper — assemble a LocationData from a LanguageCountry entry. */
function buildLocationFromCountry(
  country: LanguageCountry,
  fakerLocale: string,
  rng: () => number,
): LocationData {
  const city =
    country.sampleCities[Math.floor(rng() * country.sampleCities.length)] ??
    country.sampleCities[0]!;
  const timezone =
    country.timezones[Math.floor(rng() * country.timezones.length)] ??
    country.timezones[0]!;
  const coords = getCityCoordinates(city, country.code);
  return {
    country: country.code,
    countryName: country.name,
    city,
    region: "",
    timezone,
    latitude: coords.latitude + (rng() - 0.5),
    longitude: coords.longitude + (rng() - 0.5),
    fakerLocale,
    phoneFormat: country.phoneFormat,
  };
}

// ---------------------------------------------------------------------------
// Device profile
// ---------------------------------------------------------------------------

interface DeviceProfile {
  deviceType: DeviceType;
  browser: string;
  os: string;
  userAgent: string;
}

function pickDeviceType(
  metadata: SystemMetadataConfig,
  rng: () => number,
): DeviceType {
  const cfg = metadata.device_type;
  if (cfg.enabled && cfg.options.length > 0) {
    const pick = weightedPick(cfg.options, (o) => o.weight, rng);
    if (pick.value === "Mobile" || pick.value === "Desktop" || pick.value === "Tablet") {
      return pick.value;
    }
  }
  // Default fallback: 60/35/5.
  const r = rng() * 100;
  if (r < 60) return "Mobile";
  if (r < 95) return "Desktop";
  return "Tablet";
}

function pickBrowser(
  metadata: SystemMetadataConfig,
  preferred: string[],
  rng: () => number,
): string {
  const cfg = metadata.browser;
  if (cfg.enabled && cfg.options.length > 0) {
    // Filter the configured options to those that are coherent for this
    // device/OS pair (passed in as `preferred`). If none match, fall back
    // to the preferred list directly.
    const compatible = cfg.options.filter((o) => preferred.includes(o.value));
    if (compatible.length > 0) {
      return weightedPick(compatible, (o) => o.weight, rng).value;
    }
  }
  return preferred[Math.floor(rng() * preferred.length)] ?? preferred[0]!;
}

function generateDeviceProfile(
  metadata: SystemMetadataConfig,
  rng: () => number,
): DeviceProfile {
  const deviceType = pickDeviceType(metadata, rng);

  if (deviceType === "Mobile") {
    const isIOS = rng() > 0.45;
    const os = isIOS ? "iOS" : "Android";
    const browser = isIOS
      ? pickBrowser(metadata, ["Safari", "Chrome", "Firefox", "Edge"], rng)
      : pickBrowser(metadata, ["Chrome", "Samsung Internet", "Firefox", "Edge"], rng);
    return {
      deviceType,
      browser,
      os,
      userAgent: buildUserAgent({ deviceType, browser, os, rng }),
    };
  }

  if (deviceType === "Tablet") {
    // Mostly iPad with some Android tablets.
    const isIOS = rng() > 0.3;
    const os = isIOS ? "iOS" : "Android";
    const browser = isIOS
      ? pickBrowser(metadata, ["Safari", "Chrome", "Firefox"], rng)
      : pickBrowser(metadata, ["Chrome", "Samsung Internet", "Firefox"], rng);
    return {
      deviceType,
      browser,
      os,
      userAgent: buildUserAgent({ deviceType, browser, os, rng }),
    };
  }

  // Desktop
  const osCfg = metadata.os;
  let os: string;
  if (osCfg.enabled && osCfg.options.length > 0) {
    // Prefer desktop-class OSes only.
    const desktopOnly = osCfg.options.filter((o) =>
      ["Windows", "macOS", "Linux"].includes(o.value),
    );
    os =
      desktopOnly.length > 0
        ? weightedPick(desktopOnly, (o) => o.weight, rng).value
        : weightedPickFromList(["Windows", "macOS", "Linux"], [60, 30, 10], rng);
  } else {
    os = weightedPickFromList(["Windows", "macOS", "Linux"], [60, 30, 10], rng);
  }
  const browser =
    os === "macOS"
      ? pickBrowser(metadata, ["Chrome", "Safari", "Firefox", "Edge"], rng)
      : os === "Linux"
        ? pickBrowser(metadata, ["Chrome", "Firefox"], rng)
        : pickBrowser(metadata, ["Chrome", "Edge", "Firefox"], rng);

  return {
    deviceType: "Desktop",
    browser,
    os,
    userAgent: buildUserAgent({ deviceType: "Desktop", browser, os, rng }),
  };
}

// ---------------------------------------------------------------------------
// IP address (per Phase 3f config)
// ---------------------------------------------------------------------------

// Rough first-octet ranges per country. Not authoritative — just plausible
// enough to avoid obviously-wrong addresses (10.x, 127.x, 192.168.x, etc.)
// and to roughly match the persona's country.
const COUNTRY_IP_RANGES: Record<string, [number, number][]> = {
  US: [[3, 9], [12, 15], [23, 24], [50, 76], [98, 108], [173, 174], [184, 185]],
  GB: [[2, 2], [25, 25], [62, 62], [78, 78], [86, 88], [109, 109], [129, 129]],
  CA: [[24, 24], [70, 70], [99, 99], [142, 142], [184, 184], [192, 192], [206, 206]],
  AU: [[1, 1], [14, 14], [27, 27], [49, 49], [101, 101], [124, 124], [139, 139]],
  IN: [[14, 14], [27, 27], [49, 49], [59, 59], [103, 103], [117, 117], [122, 122], [157, 157]],
  DE: [[31, 31], [37, 37], [46, 46], [62, 62], [77, 78], [85, 95], [193, 193]],
  FR: [[2, 2], [37, 37], [62, 62], [77, 92], [109, 109], [176, 176], [212, 212]],
  ES: [[37, 37], [77, 80], [83, 83], [88, 95], [212, 213]],
  IT: [[2, 2], [5, 5], [37, 37], [77, 95], [151, 151], [188, 188], [212, 213]],
  BR: [[143, 143], [177, 191], [200, 201]],
  MX: [[177, 177], [187, 187], [189, 189], [200, 201]],
  JP: [[1, 1], [27, 27], [60, 60], [101, 126], [133, 133], [150, 150], [202, 211]],
  CN: [[1, 1], [27, 27], [36, 36], [42, 42], [58, 61], [101, 125], [180, 224]],
  KR: [[1, 1], [27, 27], [58, 58], [110, 125], [175, 175], [180, 180], [211, 222]],
  RU: [[5, 5], [37, 37], [62, 62], [77, 95], [176, 178], [188, 188], [212, 213]],
  AE: [[2, 2], [5, 5], [37, 37], [62, 62], [83, 83], [185, 185], [212, 213]],
  SA: [[2, 2], [37, 37], [78, 78], [82, 82], [188, 188], [212, 213]],
  EG: [[41, 41], [62, 62], [156, 156], [197, 197], [213, 213]],
  NL: [[5, 5], [37, 37], [62, 62], [77, 95], [213, 213]],
  SG: [[8, 8], [27, 27], [101, 101], [116, 116], [165, 165], [203, 203]],
  HK: [[1, 1], [14, 14], [27, 27], [42, 42], [58, 58], [203, 203], [218, 218]],
  TW: [[1, 1], [60, 60], [114, 125], [203, 203], [210, 220]],
  // Fallback handled at runtime.
};

function generateIp(
  metadata: SystemMetadataConfig,
  countryCode: string,
  rng: () => number,
): string | null {
  const cfg = metadata.ip;
  if (!cfg.enabled || cfg.mode === "none") return null;
  if (cfg.mode === "fixed") {
    return cfg.fixedIp || null;
  }
  // mode === "coherent"
  const ranges = COUNTRY_IP_RANGES[countryCode] ?? [[3, 9], [50, 76]]; // generic public space
  const [lo, hi] = ranges[Math.floor(rng() * ranges.length)]!;
  const o1 = lo + Math.floor(rng() * (hi - lo + 1));
  const o2 = Math.floor(rng() * 256);
  const o3 = Math.floor(rng() * 256);
  const o4 = 1 + Math.floor(rng() * 254); // avoid .0 / .255
  return `${o1}.${o2}.${o3}.${o4}`;
}

// ---------------------------------------------------------------------------
// Custom variable resolution
// ---------------------------------------------------------------------------

/**
 * Snapshot of persona fields available for `persona_field` variable
 * resolution. We pass these explicitly rather than the full Persona seed
 * because (a) only this subset is whitelisted in `PERSONA_FIELD_OPTIONS`,
 * and (b) `resolveVariableValues` runs before the full Persona object is
 * assembled — passing a flat snapshot keeps the dependency order obvious.
 */
interface PersonaFieldSnapshot {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  countryName: string;
  country: string;
  language: string;
}

function resolveVariableValues(
  variables: CustomVariable[],
  rng: () => number,
  submissionTime: number,
  personaSnapshot: PersonaFieldSnapshot,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  // Pre-pass: detect paired DATE variables (check-in / check-out style).
  // When two DATE variables share a stem and use a known start-end suffix
  // pair (e.g. `stay_check_in` + `stay_check_out`), generate them together
  // so the "out" date is always after the "in" date. Without this, the
  // two variables get independent random dates and the user sees
  // nonsensical orderings like checkout BEFORE check-in.
  const pairs = detectDateVariablePairs(variables);
  const handledIds = new Set<string>();

  for (const v of variables) {
    if (handledIds.has(v.id)) continue;

    // Paired DATE variables: resolve start + end together.
    const pair = pairs.get(v.id);
    if (pair && v.values.kind === "date" && pair.end.values.kind === "date") {
      const startVar = pair.role === "start" ? v : pair.end;
      const endVar = pair.role === "start" ? pair.end : v;
      // Re-narrow after the ternary — TS loses the kind="date" guard
      // through the conditional expression even though we proved it
      // above for both candidates.
      const startVals = startVar.values;
      const endVals = endVar.values;
      if (startVals.kind === "date" && endVals.kind === "date") {
        const startMs = pickDateMs(startVals.config, rng, submissionTime);
        // Stay length: 1–7 days after the start date. Reasonable default
        // for hotel stays, trips, events. We deliberately don't honor the
        // end variable's own range config — the user almost certainly
        // wants a coherent stay, not two independent dates that happen
        // to share a name prefix.
        const stayDays = 1 + Math.floor(rng() * 7);
        const endMs = startMs + stayDays * 24 * 60 * 60 * 1000;
        out[startVar.apiIdentifier] = new Date(startMs).toISOString().slice(0, 10);
        out[endVar.apiIdentifier] = new Date(endMs).toISOString().slice(0, 10);
        handledIds.add(startVar.id);
        handledIds.add(endVar.id);
        continue;
      }
    }

    const val = v.values;
    if (val.kind === "string") {
      const generated = generateStringValue(val.config, rng);
      // generateStringValue may return null when the persona draws a blank
      // from the weighted distribution. We emit an empty string so the
      // variable key still appears in the payload (SS treats "" as "not
      // provided" without rejecting the response), which is more
      // forward-compatible than dropping the key entirely.
      out[v.apiIdentifier] = generated ?? "";
    } else if (val.kind === "number") {
      if (val.config.mode === "static" && typeof val.config.staticValue === "number") {
        out[v.apiIdentifier] = val.config.staticValue;
      } else {
        const lo = val.config.min ?? 0;
        const hi = val.config.max ?? lo;
        const span = Math.max(0, hi - lo);
        if (val.config.allowDecimals) {
          // Clamp decimalPlaces to 1–4 (matches the UI control + schema
          // notes); default to 2 when unspecified.
          const places = Math.min(4, Math.max(1, val.config.decimalPlaces ?? 2));
          const raw = lo + rng() * span;
          const factor = Math.pow(10, places);
          out[v.apiIdentifier] = Math.round(raw * factor) / factor;
        } else {
          out[v.apiIdentifier] = lo + Math.round(rng() * span);
        }
      }
    } else if (val.kind === "date") {
      let ms: number;
      if (val.config.mode === "relative") {
        const days = val.config.relativeDays ?? 30;
        const back = rng() * days * 24 * 60 * 60 * 1000;
        ms = submissionTime - back;
      } else {
        const start = val.config.start ?? submissionTime - 30 * 24 * 60 * 60 * 1000;
        const end = val.config.end ?? submissionTime;
        ms = start + rng() * (end - start);
      }
      // Emit ISO date (YYYY-MM-DD) — DATE custom vars in SS expect a date,
      // not a datetime.
      out[v.apiIdentifier] = new Date(ms).toISOString().slice(0, 10);
    } else if (val.kind === "persona_field") {
      // persona_field: resolved from the Faker-generated identity, not LLM
      // output. The field is whitelisted via `PersonaFieldKey` so this lookup
      // is always safe; missing-key fallback is the empty string.
      const field = val.config.field;
      const value = personaSnapshot[field];
      out[v.apiIdentifier] = typeof value === "string" ? value : String(value ?? "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// STRING value generation — modes + blank support
// ---------------------------------------------------------------------------

/**
 * Per-persona STRING value resolution. Handles three independent dimensions:
 *
 *   1. Mode: "options" (weighted fixed list) vs "examples" (pattern-based
 *      similar-value generation from user-supplied examples). Defaults to
 *      "options" when undefined for backward compat with profiles saved
 *      before mode was a field.
 *
 *   2. Blank: when `allowBlank` is set, the blank outcome participates in
 *      the weighted draw with weight `blankWeight`. Returns null when the
 *      persona drew blank.
 *
 *   3. Empty input: every mode degrades gracefully — empty options list
 *      with blank disallowed returns null (the caller then writes "" to
 *      the payload).
 */
function generateStringValue(
  config: import("@/lib/profiles/types").StringValueConfig,
  rng: () => number,
): string | null {
  const mode = config.mode ?? "options";
  const allowBlank = config.allowBlank === true;
  const blankWeight = allowBlank ? Math.max(0, Math.min(100, config.blankWeight ?? 0)) : 0;

  // ---- Weighted blank draw ----
  // We model the blank outcome as a virtual entry alongside the value
  // entries. Total weight = sum(non-blank weights) + blankWeight. If the
  // random pick lands inside the blank slice, return null.
  const valueEntries: Array<{ text: string; weight: number }> = [];
  if (mode === "options") {
    for (const o of config.options) {
      if (o.weight > 0) valueEntries.push({ text: o.text, weight: o.weight });
    }
  } else {
    // "examples" mode — flat-weight the examples; the variation step below
    // adds per-emission randomness.
    const examples = (config.examples ?? []).filter((e) => e.trim().length > 0);
    for (const ex of examples) {
      valueEntries.push({ text: ex, weight: 1 });
    }
  }

  const valueWeightSum = valueEntries.reduce((s, e) => s + e.weight, 0);
  const totalWeight = valueWeightSum + blankWeight;
  if (totalWeight <= 0) {
    // Nothing configured at all — emit blank.
    return null;
  }

  let pick = rng() * totalWeight;
  if (blankWeight > 0) {
    if (pick < blankWeight) return null;
    pick -= blankWeight;
  }

  // Now pick from value entries.
  let chosen: string | null = null;
  for (const e of valueEntries) {
    pick -= e.weight;
    if (pick <= 0) {
      chosen = e.text;
      break;
    }
  }
  if (chosen == null) chosen = valueEntries[valueEntries.length - 1]?.text ?? null;
  if (chosen == null) return null;

  // For examples mode, apply pattern-based variation so successive
  // responses get similar-looking-but-distinct values. For options mode,
  // the user already curated the exact text — emit verbatim.
  if (mode === "examples") {
    return varyExample(chosen, rng);
  }
  return chosen;
}

/**
 * Apply lightweight pattern-based variation to a single example string.
 *
 * Goal: take "TCK-102938" and emit "TCK-104582" / "TCK-118903" / etc. —
 * the same shape with the variable parts randomized. The rule is simple:
 * find every digit run of length ≥ 3 and replace its digits with random
 * digits of the same length. This preserves prefixes ("TCK-"), separators
 * ("-"), and short numeric suffixes ("v2", "i3") while randomising the
 * "ID-like" portions.
 *
 * Free-form text without long digit runs ("Marvin Certified Dealer")
 * passes through unchanged — the user gets variety by listing multiple
 * examples instead. This is intentional: synthesizing semantically-
 * similar free text without an LLM call is unreliable, and the user
 * explicitly asked for "no expensive per-response LLM calls only for
 * variable values."
 */
function varyExample(example: string, rng: () => number): string {
  return example.replace(/\d{3,}/g, (match) => {
    let out = "";
    for (let i = 0; i < match.length; i++) {
      out += Math.floor(rng() * 10).toString();
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// DATE variable pairing (check-in / check-out)
// ---------------------------------------------------------------------------
//
// SS workspaces commonly have related DATE variables for stays / trips /
// events / employment, e.g. `stay_check_in` + `stay_check_out`. The faker
// layer used to resolve each independently, which produced nonsensical
// orderings (check-out before check-in) for half of the personas. This
// pairing pre-pass detects related pairs by suffix and resolves them as
// a coherent (start, end) window.
//
// Detection is conservative — we only pair variables when:
//   1. Both are DATE-typed.
//   2. The names share a stem AND end with a matched suffix pair below.
//
// Single DATE variables without a partner fall through to the normal
// per-variable resolution.

const DATE_PAIR_SUFFIXES: ReadonlyArray<{ start: string; end: string }> = [
  { start: "_check_in", end: "_check_out" },
  { start: "_checkin", end: "_checkout" },
  { start: "_in", end: "_out" },
  { start: "_start", end: "_end" },
  { start: "_from", end: "_to" },
  { start: "_arrival", end: "_departure" },
  { start: "_begin", end: "_end" },
];

interface DatePairInfo {
  /** The other half of the pair. */
  end: CustomVariable;
  /** Role of THIS variable in the pair. */
  role: "start" | "end";
}

/**
 * Return a map keyed by variable id whose value tells the caller the
 * variable's role in a detected pair and a reference to its partner. Each
 * paired variable appears in the map TWICE (once as start, once as end),
 * so callers can early-exit on the second one via `handledIds`.
 */
function detectDateVariablePairs(
  variables: CustomVariable[],
): Map<string, DatePairInfo> {
  const dateVars = variables.filter((v) => v.values.kind === "date");
  if (dateVars.length < 2) return new Map();

  // Lookup by lowercased name for case-insensitive matching.
  const byName = new Map<string, CustomVariable>();
  for (const v of dateVars) {
    byName.set(v.apiIdentifier.toLowerCase(), v);
  }

  const result = new Map<string, DatePairInfo>();
  for (const v of dateVars) {
    if (result.has(v.id)) continue; // already paired
    const name = v.apiIdentifier.toLowerCase();
    for (const { start, end } of DATE_PAIR_SUFFIXES) {
      // Try matching the END suffix first — checked longest-first below
      // would also work, but the array is already ordered start before
      // end for each entry. The two branches are symmetric.
      if (name.endsWith(start)) {
        const stem = name.slice(0, -start.length);
        if (!stem) continue;
        const partner = byName.get(stem + end);
        if (partner && partner.id !== v.id && !result.has(partner.id)) {
          result.set(v.id, { end: partner, role: "start" });
          result.set(partner.id, { end: v, role: "end" });
          break;
        }
      }
      if (name.endsWith(end)) {
        const stem = name.slice(0, -end.length);
        if (!stem) continue;
        const partner = byName.get(stem + start);
        if (partner && partner.id !== v.id && !result.has(partner.id)) {
          result.set(v.id, { end: partner, role: "end" });
          result.set(partner.id, { end: v, role: "start" });
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Resolve a DateValueConfig to an epoch-ms instant. Mirrors the inline
 * logic the single-variable path uses, factored out so the pairing path
 * can reuse it without duplicating the relative / range branches.
 */
function pickDateMs(
  config: import("@/lib/profiles/types").DateValueConfig,
  rng: () => number,
  submissionTime: number,
): number {
  if (config.mode === "relative") {
    const days = config.relativeDays ?? 30;
    const back = rng() * days * 24 * 60 * 60 * 1000;
    return submissionTime - back;
  }
  const start = config.start ?? submissionTime - 30 * 24 * 60 * 60 * 1000;
  const end = config.end ?? submissionTime;
  return start + rng() * (end - start);
}

// ---------------------------------------------------------------------------
// Sentiment archetype assignment (per persona distribution)
// ---------------------------------------------------------------------------

function assignSentiments(
  count: number,
  distribution: PersonaDistribution,
): SentimentArchetype[] {
  // Allocate counts deterministically, then shuffle so the archetypes aren't
  // contiguous in the persona array.
  const promoterCount = Math.round((distribution.promoter / 100) * count);
  const detractorCount = Math.round((distribution.detractor / 100) * count);
  const passiveCount = Math.max(0, count - promoterCount - detractorCount);

  const out: SentimentArchetype[] = [
    ...Array<SentimentArchetype>(promoterCount).fill("promoter"),
    ...Array<SentimentArchetype>(passiveCount).fill("passive"),
    ...Array<SentimentArchetype>(detractorCount).fill("detractor"),
  ];

  // Fisher-Yates shuffle.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, count);
}

// ---------------------------------------------------------------------------
// Language assignment per language distribution
// ---------------------------------------------------------------------------

function assignLanguages(count: number, distribution: LanguageWeight[]): string[] {
  const enabled = distribution.filter((l) => l.weight > 0);
  if (enabled.length === 0) {
    return Array<string>(count).fill("en");
  }
  // Allocate counts proportionally, then pad rounding error to the largest.
  const totalWeight = enabled.reduce((a, b) => a + b.weight, 0);
  const counts = enabled.map((l) => Math.round((l.weight / totalWeight) * count));
  let allocated = counts.reduce((a, b) => a + b, 0);
  // Adjust to exactly match `count`.
  let i = 0;
  while (allocated < count && enabled.length > 0) {
    counts[i % counts.length]! += 1;
    allocated += 1;
    i += 1;
  }
  while (allocated > count && enabled.length > 0) {
    if (counts[i % counts.length]! > 0) {
      counts[i % counts.length]! -= 1;
      allocated -= 1;
    }
    i += 1;
  }
  const out: string[] = [];
  enabled.forEach((l, idx) => {
    out.push(...Array<string>(counts[idx] ?? 0).fill(l.code));
  });
  // Shuffle so language order doesn't correlate with persona index.
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [out[k], out[j]] = [out[j]!, out[k]!];
  }
  return out.slice(0, count);
}

// ---------------------------------------------------------------------------
// Top-level: build the deterministic skeleton of N personas.
// ---------------------------------------------------------------------------

/**
 * Output of the Faker layer — everything we know about each persona BEFORE
 * the LLM runs. The personality fields default to neutral values that the
 * LLM call overwrites; if the LLM call fails for a given persona we keep
 * these defaults and the persona is still usable downstream.
 */
export type PersonaSeed = Persona;

export function buildPersonaSeeds(
  draft: ProfileDraft,
  responseCount: number,
): PersonaSeed[] {
  // Pre-compute everything that doesn't depend on per-persona randomness.
  const sentiments = assignSentiments(responseCount, draft.personaDistribution);
  const languages = assignLanguages(responseCount, draft.languageDistribution);
  const timestamps = generateTimestamps(responseCount, draft.timeRange);

  const seeds: PersonaSeed[] = [];
  for (let i = 0; i < responseCount; i++) {
    const sentiment = sentiments[i] ?? "passive";
    const language = languages[i] ?? "en";
    const submittedAt = timestamps[i] ?? new Date(draft.timeRange.to);

    // Each persona gets a fresh `rng` — we use `Math.random` directly,
    // mirroring Math.random's ergonomics. If we ever want determinism per
    // persona id, we can swap in a seeded PRNG without touching the API.
    const rng = Math.random;

    const location = assignLocation(language, draft.countryFilter ?? [], rng);
    const faker = resolveFaker(location.fakerLocale);
    // Re-seed faker per persona so consecutive personas don't collide on
    // identical names. Faker's seed is process-global, so vary it heavily.
    faker.seed(Math.floor(Math.random() * 2 ** 32));

    const country: LanguageCountry = {
      code: location.country,
      name: location.countryName,
      weight: 1, // unused here — we already picked
      timezones: [location.timezone],
      sampleCities: [location.city],
      phoneFormat: location.phoneFormat,
      fakerLocale: location.fakerLocale,
    };
    const identity = generateIdentity(faker, country, rng);
    const device = generateDeviceProfile(draft.systemMetadata, rng);
    const ipAddress = generateIp(draft.systemMetadata, location.country, rng);
    // Build the persona-field snapshot AFTER identity + location are
    // assigned, so `persona_field` custom variables can mirror them.
    const personaSnapshot = {
      firstName: identity.firstName,
      lastName: identity.lastName,
      name: identity.name,
      email: identity.email,
      phone: identity.phone,
      city: location.city,
      countryName: location.countryName,
      country: location.country,
      language,
    };
    const variableValues = resolveVariableValues(
      draft.customVariables,
      rng,
      submittedAt.getTime(),
      personaSnapshot,
    );

    seeds.push({
      id: cryptoUuid(),
      index: i + 1,
      name: identity.name,
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: identity.email,
      phone: identity.phone,

      language,
      country: location.country,
      countryName: location.countryName,
      city: location.city,
      region: location.region,
      timezone: location.timezone,
      latitude: round2(location.latitude),
      longitude: round2(location.longitude),

      deviceType: device.deviceType,
      browser: device.browser,
      os: device.os,
      userAgent: device.userAgent,

      submittedAt: submittedAt.toISOString(),
      ipAddress,

      // Defaults — overwritten by LLM output.
      sentimentArchetype: sentiment,
      keyConcerns: [],
      themesTouched: [],
      verbosity: "medium",
      demographicNotes: "",

      variableValues,
    });
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weightedPick<T>(items: T[], weight: (item: T) => number, rng: () => number): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)] ?? items[0]!;
  let r = rng() * total;
  for (const item of items) {
    r -= Math.max(0, weight(item));
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function weightedPickFromList<T>(items: T[], weights: number[], rng: () => number): T {
  return weightedPick(
    items.map((item, idx) => ({ item, w: weights[idx] ?? 1 })),
    (e) => e.w,
    rng,
  ).item;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cryptoUuid(): string {
  // Use the crypto API on both Node 22 and modern browsers. Falls back to
  // Math.random if unavailable (extremely unlikely in our environments).
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `p_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

// `responseCount` historically lived on `TimeRangeConfig.responseCount`; we
// re-export the type so callers don't need to dig into profiles/types.
export type { TimeRangeConfig };
