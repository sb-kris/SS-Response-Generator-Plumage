// Language → country geography registry. Powers the Languages section of
// Configure (Phase 3c) and feeds Phase 4's persona metadata generation
// (names, geography, phone formats).
//
// Data conventions:
//   - `code`               — ISO 639-1 language code (lowercase)
//   - `nativeName`         — language name in the language itself
//   - `flag`               — flag emoji of the language's primary region
//   - `fakerLocale`        — language-level Faker locale, used as fallback
//   - `countries[].weight` — % of personas of this language placed in this
//                            country. Should sum to 100 per language.
//                            Numbers are rough demographic priors (literate
//                            speaker populations / market relevance), not
//                            statistical absolutes.
//   - `countries[].fakerLocale` — country-specific Faker locale; falls back
//                                 to the language-level one if absent.
//   - `phoneFormat`        — Faker.helpers.fromRegExp / replaceSymbols pattern;
//                            `#` is a digit. Country dial code included.
//
// Reference: https://fakerjs.dev/guide/localization.html
//
// Quality bar from the spec: "If you're unsure about a country's plausibility
// for a language, err toward the canonical set." Cities are real, timezones
// are IANA-correct, and weights are conservative defaults that demos can
// override at runtime.

export interface LanguageCountry {
  code: string;        // ISO 3166-1 alpha-2
  name: string;        // English country name
  weight: number;      // % of personas of this language placed here (sum to 100)
  timezones: string[]; // IANA timezone identifiers
  sampleCities: string[];
  phoneFormat: string; // `#` is a digit; full international form
  /** Country-specific Faker locale; falls back to the language-level one. */
  fakerLocale?: string;
}

export interface LanguageDef {
  code: string;        // ISO 639-1, lowercase
  name: string;        // English name
  nativeName: string;
  flag: string;        // emoji
  fakerLocale: string; // base Faker locale; per-country may override
  /** Editorial note rendered as a tooltip — used to flag known caveats. */
  notes?: string;
  countries: LanguageCountry[];
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

const LANGUAGES_RAW: LanguageDef[] = [
  // ENGLISH
  {
    code: "en",
    name: "English",
    nativeName: "English",
    flag: "🇺🇸",
    fakerLocale: "en",
    countries: [
      {
        code: "US",
        name: "United States",
        weight: 50,
        timezones: [
          "America/New_York",
          "America/Chicago",
          "America/Denver",
          "America/Los_Angeles",
          "America/Phoenix",
        ],
        sampleCities: ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia"],
        phoneFormat: "+1 (###) ###-####",
        fakerLocale: "en_US",
      },
      {
        code: "GB",
        name: "United Kingdom",
        weight: 20,
        timezones: ["Europe/London"],
        sampleCities: ["London", "Manchester", "Birmingham", "Glasgow", "Liverpool", "Edinburgh"],
        phoneFormat: "+44 ## #### ####",
        fakerLocale: "en_GB",
      },
      {
        code: "CA",
        name: "Canada",
        weight: 12,
        timezones: ["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Halifax"],
        sampleCities: ["Toronto", "Vancouver", "Calgary", "Ottawa", "Edmonton", "Winnipeg"],
        phoneFormat: "+1 (###) ###-####",
        fakerLocale: "en_CA",
      },
      {
        code: "AU",
        name: "Australia",
        weight: 10,
        timezones: ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth"],
        sampleCities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Hobart"],
        phoneFormat: "+61 ### ### ###",
        fakerLocale: "en_AU",
      },
      {
        code: "IN",
        name: "India",
        weight: 5,
        timezones: ["Asia/Kolkata"],
        sampleCities: ["Mumbai", "Bengaluru", "Delhi", "Chennai", "Hyderabad", "Pune"],
        phoneFormat: "+91 ##### #####",
        fakerLocale: "en_IN",
      },
      {
        code: "IE",
        name: "Ireland",
        weight: 3,
        timezones: ["Europe/Dublin"],
        sampleCities: ["Dublin", "Cork", "Galway", "Limerick"],
        phoneFormat: "+353 ## ### ####",
        fakerLocale: "en_IE",
      },
    ],
  },

  // SPANISH
  {
    code: "es",
    name: "Spanish",
    nativeName: "Español",
    flag: "🇪🇸",
    fakerLocale: "es",
    countries: [
      {
        code: "MX",
        name: "Mexico",
        weight: 35,
        timezones: ["America/Mexico_City", "America/Tijuana", "America/Monterrey"],
        sampleCities: ["Mexico City", "Guadalajara", "Monterrey", "Puebla", "Tijuana", "León"],
        phoneFormat: "+52 ###-###-####",
        fakerLocale: "es_MX",
      },
      {
        code: "ES",
        name: "Spain",
        weight: 25,
        timezones: ["Europe/Madrid"],
        sampleCities: ["Madrid", "Barcelona", "Valencia", "Sevilla", "Zaragoza", "Málaga"],
        phoneFormat: "+34 ### ### ###",
        fakerLocale: "es",
      },
      {
        code: "AR",
        name: "Argentina",
        weight: 12,
        timezones: ["America/Argentina/Buenos_Aires", "America/Argentina/Cordoba"],
        sampleCities: ["Buenos Aires", "Córdoba", "Rosario", "Mendoza", "La Plata", "Mar del Plata"],
        phoneFormat: "+54 ## ####-####",
        fakerLocale: "es",
      },
      {
        code: "CO",
        name: "Colombia",
        weight: 12,
        timezones: ["America/Bogota"],
        sampleCities: ["Bogotá", "Medellín", "Cali", "Barranquilla", "Cartagena", "Bucaramanga"],
        phoneFormat: "+57 ### ### ####",
        fakerLocale: "es",
      },
      {
        code: "CL",
        name: "Chile",
        weight: 8,
        timezones: ["America/Santiago"],
        sampleCities: ["Santiago", "Valparaíso", "Concepción", "Viña del Mar", "Antofagasta", "La Serena"],
        phoneFormat: "+56 # #### ####",
        fakerLocale: "es",
      },
      {
        code: "PE",
        name: "Peru",
        weight: 8,
        timezones: ["America/Lima"],
        sampleCities: ["Lima", "Arequipa", "Trujillo", "Chiclayo", "Cusco", "Piura"],
        phoneFormat: "+51 ### ### ###",
        fakerLocale: "es",
      },
    ],
  },

  // FRENCH
  {
    code: "fr",
    name: "French",
    nativeName: "Français",
    flag: "🇫🇷",
    fakerLocale: "fr",
    countries: [
      {
        code: "FR",
        name: "France",
        weight: 65,
        timezones: ["Europe/Paris"],
        sampleCities: ["Paris", "Marseille", "Lyon", "Toulouse", "Nice", "Nantes", "Bordeaux"],
        phoneFormat: "+33 # ## ## ## ##",
        fakerLocale: "fr",
      },
      {
        code: "CA",
        name: "Canada (Québec)",
        weight: 15,
        timezones: ["America/Toronto"],
        sampleCities: ["Montréal", "Québec City", "Gatineau", "Sherbrooke", "Trois-Rivières", "Laval"],
        phoneFormat: "+1 (###) ###-####",
        fakerLocale: "fr_CA",
      },
      {
        code: "BE",
        name: "Belgium",
        weight: 8,
        timezones: ["Europe/Brussels"],
        sampleCities: ["Brussels", "Liège", "Charleroi", "Namur", "Mons"],
        phoneFormat: "+32 ### ## ## ##",
        fakerLocale: "fr_BE",
      },
      {
        code: "CH",
        name: "Switzerland",
        weight: 7,
        timezones: ["Europe/Zurich"],
        sampleCities: ["Geneva", "Lausanne", "Lucerne", "Bern", "Fribourg"],
        phoneFormat: "+41 ## ### ## ##",
        fakerLocale: "fr_CH",
      },
      {
        code: "MA",
        name: "Morocco",
        weight: 5,
        timezones: ["Africa/Casablanca"],
        sampleCities: ["Casablanca", "Rabat", "Marrakech", "Fès", "Tangier"],
        phoneFormat: "+212 ### ######",
        // No fr_MA in Faker; falls back to fr.
      },
    ],
  },

  // HINDI
  {
    code: "hi",
    name: "Hindi",
    nativeName: "हिन्दी",
    flag: "🇮🇳",
    fakerLocale: "hi",
    notes:
      "Faker's `hi` locale is incomplete — names may fall back to en_IN at generation time. Geography stays Hindi-paired.",
    countries: [
      {
        code: "IN",
        name: "India",
        weight: 100,
        timezones: ["Asia/Kolkata"],
        sampleCities: ["Delhi", "Mumbai", "Lucknow", "Kanpur", "Patna", "Jaipur", "Indore", "Nagpur"],
        phoneFormat: "+91 ##### #####",
        fakerLocale: "hi",
      },
    ],
  },

  // PORTUGUESE
  {
    code: "pt",
    name: "Portuguese",
    nativeName: "Português",
    flag: "🇧🇷",
    fakerLocale: "pt_BR",
    countries: [
      {
        code: "BR",
        name: "Brazil",
        weight: 75,
        timezones: ["America/Sao_Paulo", "America/Bahia", "America/Recife", "America/Manaus"],
        sampleCities: ["São Paulo", "Rio de Janeiro", "Brasília", "Salvador", "Fortaleza", "Belo Horizonte"],
        phoneFormat: "+55 (##) #####-####",
        fakerLocale: "pt_BR",
      },
      {
        code: "PT",
        name: "Portugal",
        weight: 25,
        timezones: ["Europe/Lisbon"],
        sampleCities: ["Lisbon", "Porto", "Braga", "Coimbra", "Aveiro", "Faro"],
        phoneFormat: "+351 ### ### ###",
        fakerLocale: "pt_PT",
      },
    ],
  },

  // GERMAN
  {
    code: "de",
    name: "German",
    nativeName: "Deutsch",
    flag: "🇩🇪",
    fakerLocale: "de",
    countries: [
      {
        code: "DE",
        name: "Germany",
        weight: 70,
        timezones: ["Europe/Berlin"],
        sampleCities: ["Berlin", "Hamburg", "München", "Köln", "Frankfurt", "Stuttgart", "Dresden"],
        phoneFormat: "+49 ### #######",
        fakerLocale: "de",
      },
      {
        code: "AT",
        name: "Austria",
        weight: 15,
        timezones: ["Europe/Vienna"],
        sampleCities: ["Vienna", "Graz", "Linz", "Salzburg", "Innsbruck"],
        phoneFormat: "+43 # ### ####",
        fakerLocale: "de_AT",
      },
      {
        code: "CH",
        name: "Switzerland",
        weight: 15,
        timezones: ["Europe/Zurich"],
        sampleCities: ["Zürich", "Basel", "Bern", "Lucerne", "St. Gallen"],
        phoneFormat: "+41 ## ### ## ##",
        fakerLocale: "de_CH",
      },
    ],
  },

  // JAPANESE
  {
    code: "ja",
    name: "Japanese",
    nativeName: "日本語",
    flag: "🇯🇵",
    fakerLocale: "ja",
    countries: [
      {
        code: "JP",
        name: "Japan",
        weight: 100,
        timezones: ["Asia/Tokyo"],
        sampleCities: ["Tokyo", "Osaka", "Yokohama", "Nagoya", "Sapporo", "Kobe", "Kyoto", "Fukuoka"],
        phoneFormat: "+81 ## #### ####",
        fakerLocale: "ja",
      },
    ],
  },

  // CHINESE
  {
    code: "zh",
    name: "Chinese",
    nativeName: "中文",
    flag: "🇨🇳",
    fakerLocale: "zh_CN",
    notes:
      "Mainland uses Simplified Chinese (zh_CN); Taiwan and Hong Kong use Traditional (zh_TW). Singapore uses Simplified.",
    countries: [
      {
        code: "CN",
        name: "China",
        weight: 50,
        timezones: ["Asia/Shanghai"],
        sampleCities: ["Beijing", "Shanghai", "Guangzhou", "Shenzhen", "Chengdu", "Hangzhou", "Wuhan"],
        phoneFormat: "+86 ### #### ####",
        fakerLocale: "zh_CN",
      },
      {
        code: "TW",
        name: "Taiwan",
        weight: 20,
        timezones: ["Asia/Taipei"],
        sampleCities: ["Taipei", "Kaohsiung", "Taichung", "Tainan", "Taoyuan"],
        phoneFormat: "+886 # #### ####",
        fakerLocale: "zh_TW",
      },
      {
        code: "HK",
        name: "Hong Kong",
        weight: 15,
        timezones: ["Asia/Hong_Kong"],
        sampleCities: ["Hong Kong", "Kowloon", "New Territories"],
        phoneFormat: "+852 #### ####",
        fakerLocale: "zh_TW",
      },
      {
        code: "SG",
        name: "Singapore",
        weight: 15,
        timezones: ["Asia/Singapore"],
        sampleCities: ["Singapore"],
        phoneFormat: "+65 #### ####",
        fakerLocale: "zh_CN",
      },
    ],
  },

  // ARABIC
  {
    code: "ar",
    name: "Arabic",
    nativeName: "العربية",
    flag: "🇸🇦",
    fakerLocale: "ar",
    notes:
      "Arabic is RTL — open-text answers will render right-to-left in Phase 5. Configuration UI itself stays LTR.",
    countries: [
      {
        code: "SA",
        name: "Saudi Arabia",
        weight: 25,
        timezones: ["Asia/Riyadh"],
        sampleCities: ["Riyadh", "Jeddah", "Mecca", "Medina", "Dammam"],
        phoneFormat: "+966 # ### ####",
      },
      {
        code: "EG",
        name: "Egypt",
        weight: 25,
        timezones: ["Africa/Cairo"],
        sampleCities: ["Cairo", "Alexandria", "Giza", "Sharm El Sheikh", "Luxor"],
        phoneFormat: "+20 ## ##### ####",
      },
      {
        code: "AE",
        name: "United Arab Emirates",
        weight: 20,
        timezones: ["Asia/Dubai"],
        sampleCities: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Fujairah"],
        phoneFormat: "+971 ## ### ####",
      },
      {
        code: "JO",
        name: "Jordan",
        weight: 10,
        timezones: ["Asia/Amman"],
        sampleCities: ["Amman", "Zarqa", "Irbid", "Aqaba"],
        phoneFormat: "+962 # ### ####",
      },
      {
        code: "MA",
        name: "Morocco",
        weight: 10,
        timezones: ["Africa/Casablanca"],
        sampleCities: ["Casablanca", "Rabat", "Fès", "Marrakech", "Tangier"],
        phoneFormat: "+212 ### ######",
      },
      {
        code: "KW",
        name: "Kuwait",
        weight: 10,
        timezones: ["Asia/Kuwait"],
        sampleCities: ["Kuwait City", "Hawalli", "Salmiya"],
        phoneFormat: "+965 #### ####",
      },
    ],
  },

  // ITALIAN
  {
    code: "it",
    name: "Italian",
    nativeName: "Italiano",
    flag: "🇮🇹",
    fakerLocale: "it",
    countries: [
      {
        code: "IT",
        name: "Italy",
        weight: 90,
        timezones: ["Europe/Rome"],
        sampleCities: ["Rome", "Milan", "Naples", "Turin", "Florence", "Bologna", "Venice"],
        phoneFormat: "+39 ### ### ####",
        fakerLocale: "it",
      },
      {
        code: "CH",
        name: "Switzerland (Ticino)",
        weight: 10,
        timezones: ["Europe/Zurich"],
        sampleCities: ["Lugano", "Bellinzona", "Locarno", "Mendrisio"],
        phoneFormat: "+41 ## ### ## ##",
        // No it_CH in Faker; falls back to it.
      },
    ],
  },

  // DUTCH
  {
    code: "nl",
    name: "Dutch",
    nativeName: "Nederlands",
    flag: "🇳🇱",
    fakerLocale: "nl",
    countries: [
      {
        code: "NL",
        name: "Netherlands",
        weight: 75,
        timezones: ["Europe/Amsterdam"],
        sampleCities: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht", "Eindhoven", "Groningen"],
        phoneFormat: "+31 ## ### ####",
        fakerLocale: "nl",
      },
      {
        code: "BE",
        name: "Belgium (Flanders)",
        weight: 25,
        timezones: ["Europe/Brussels"],
        sampleCities: ["Antwerp", "Ghent", "Bruges", "Leuven", "Mechelen"],
        phoneFormat: "+32 ### ## ## ##",
        fakerLocale: "nl_BE",
      },
    ],
  },

  // KOREAN
  {
    code: "ko",
    name: "Korean",
    nativeName: "한국어",
    flag: "🇰🇷",
    fakerLocale: "ko",
    countries: [
      {
        code: "KR",
        name: "South Korea",
        weight: 100,
        timezones: ["Asia/Seoul"],
        sampleCities: ["Seoul", "Busan", "Incheon", "Daegu", "Daejeon", "Gwangju", "Suwon"],
        phoneFormat: "+82 ## #### ####",
        fakerLocale: "ko",
      },
    ],
  },

  // RUSSIAN
  {
    code: "ru",
    name: "Russian",
    nativeName: "Русский",
    flag: "🇷🇺",
    fakerLocale: "ru",
    countries: [
      {
        code: "RU",
        name: "Russia",
        weight: 90,
        timezones: ["Europe/Moscow", "Asia/Yekaterinburg", "Asia/Novosibirsk"],
        sampleCities: ["Moscow", "Saint Petersburg", "Novosibirsk", "Yekaterinburg", "Nizhny Novgorod", "Kazan"],
        phoneFormat: "+7 ### ### ####",
        fakerLocale: "ru",
      },
      {
        code: "KZ",
        name: "Kazakhstan",
        weight: 5,
        timezones: ["Asia/Almaty"],
        sampleCities: ["Almaty", "Astana", "Shymkent", "Karaganda"],
        phoneFormat: "+7 ### ### ####",
      },
      {
        code: "BY",
        name: "Belarus",
        weight: 5,
        timezones: ["Europe/Minsk"],
        sampleCities: ["Minsk", "Gomel", "Mogilev", "Vitebsk"],
        phoneFormat: "+375 ## ### ####",
      },
    ],
  },
];

// Sanity check at module load: each language's country weights must sum to 100.
// Throws in dev so a typo here shows up at import time.
function assertCountryWeightsSumTo100(): void {
  for (const lang of LANGUAGES_RAW) {
    const sum = lang.countries.reduce((acc, c) => acc + c.weight, 0);
    if (sum !== 100) {
      const message = `language-geography: ${lang.code} country weights sum to ${sum}, expected 100`;
      // Don't crash production, but make the issue visible in dev console / tests.
      if (typeof console !== "undefined") console.warn(message);
    }
  }
}
assertCountryWeightsSumTo100();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const LANGUAGES: readonly LanguageDef[] = LANGUAGES_RAW;

export const LANGUAGES_BY_CODE: Readonly<Record<string, LanguageDef>> = Object.freeze(
  LANGUAGES_RAW.reduce<Record<string, LanguageDef>>((acc, l) => {
    acc[l.code] = l;
    return acc;
  }, {}),
);

export function getLanguage(code: string): LanguageDef | undefined {
  return LANGUAGES_BY_CODE[code.toLowerCase()];
}

export function isSupportedLanguage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGUAGES_BY_CODE, code.toLowerCase());
}

export interface CountryPreviewItem {
  code: string;
  name: string;
  weight: number;
  flag: string; // Regional indicator emoji built from country code
}

/**
 * Country breakdown for UI preview chips. Sorted by weight desc.
 * Country flags are built from the alpha-2 code via regional indicators
 * (no need for a separate emoji mapping table).
 */
export function getCountryPreview(languageCode: string): CountryPreviewItem[] {
  const lang = getLanguage(languageCode);
  if (!lang) return [];
  return lang.countries
    .map((c) => ({
      code: c.code,
      name: c.name,
      weight: c.weight,
      flag: countryFlag(c.code),
    }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Build the flag emoji for a 2-letter ISO country code.
 *  US → 🇺🇸  GB → 🇬🇧  ...
 */
export function countryFlag(alpha2: string): string {
  if (alpha2.length !== 2) return "";
  const A = 0x41; // 'A'
  const REGIONAL_A = 0x1f1e6; // 🇦
  const upper = alpha2.toUpperCase();
  const cp1 = upper.charCodeAt(0) - A + REGIONAL_A;
  const cp2 = upper.charCodeAt(1) - A + REGIONAL_A;
  return String.fromCodePoint(cp1, cp2);
}
