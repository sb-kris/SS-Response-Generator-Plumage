// Static registry of ~90 countries for the Country Filter feature.
// Covers G20, EU, APAC, LatAm, and MEA — sufficient for typical presales
// demos without being exhaustive. `region` drives grouping in the picker UI.

export type CountryRegion =
  | "Americas"
  | "Europe"
  | "Asia Pacific"
  | "Middle East & Africa"
  | "CIS / Central Asia";

export interface WorldCountry {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  code: string;
  name: string;
  region: CountryRegion;
}

/**
 * Derive the Unicode flag emoji for a two-letter ISO country code.
 * Regional indicator symbols start at 0x1F1E6 ('A'), so each letter maps to
 * the codepoint offset by its alphabetic position.
 */
export function countryFlagEmoji(code: string): string {
  return [...code.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

export const WORLD_COUNTRIES: WorldCountry[] = [
  // --- Americas -------------------------------------------------------
  { code: "US", name: "United States",   region: "Americas" },
  { code: "CA", name: "Canada",          region: "Americas" },
  { code: "MX", name: "Mexico",          region: "Americas" },
  { code: "BR", name: "Brazil",          region: "Americas" },
  { code: "AR", name: "Argentina",       region: "Americas" },
  { code: "CO", name: "Colombia",        region: "Americas" },
  { code: "CL", name: "Chile",           region: "Americas" },
  { code: "PE", name: "Peru",            region: "Americas" },
  { code: "VE", name: "Venezuela",       region: "Americas" },
  { code: "EC", name: "Ecuador",         region: "Americas" },
  { code: "GT", name: "Guatemala",       region: "Americas" },
  { code: "PR", name: "Puerto Rico",     region: "Americas" },

  // --- Europe ---------------------------------------------------------
  { code: "GB", name: "United Kingdom",  region: "Europe" },
  { code: "DE", name: "Germany",         region: "Europe" },
  { code: "FR", name: "France",          region: "Europe" },
  { code: "IT", name: "Italy",           region: "Europe" },
  { code: "ES", name: "Spain",           region: "Europe" },
  { code: "NL", name: "Netherlands",     region: "Europe" },
  { code: "PT", name: "Portugal",        region: "Europe" },
  { code: "SE", name: "Sweden",          region: "Europe" },
  { code: "NO", name: "Norway",          region: "Europe" },
  { code: "DK", name: "Denmark",         region: "Europe" },
  { code: "FI", name: "Finland",         region: "Europe" },
  { code: "BE", name: "Belgium",         region: "Europe" },
  { code: "CH", name: "Switzerland",     region: "Europe" },
  { code: "AT", name: "Austria",         region: "Europe" },
  { code: "PL", name: "Poland",          region: "Europe" },
  { code: "CZ", name: "Czech Republic",  region: "Europe" },
  { code: "HU", name: "Hungary",         region: "Europe" },
  { code: "RO", name: "Romania",         region: "Europe" },
  { code: "GR", name: "Greece",          region: "Europe" },
  { code: "TR", name: "Turkey",          region: "Europe" },
  { code: "IE", name: "Ireland",         region: "Europe" },
  { code: "SK", name: "Slovakia",        region: "Europe" },
  { code: "HR", name: "Croatia",         region: "Europe" },

  // --- Asia Pacific ---------------------------------------------------
  { code: "JP", name: "Japan",           region: "Asia Pacific" },
  { code: "CN", name: "China",           region: "Asia Pacific" },
  { code: "IN", name: "India",           region: "Asia Pacific" },
  { code: "KR", name: "South Korea",     region: "Asia Pacific" },
  { code: "AU", name: "Australia",       region: "Asia Pacific" },
  { code: "NZ", name: "New Zealand",     region: "Asia Pacific" },
  { code: "SG", name: "Singapore",       region: "Asia Pacific" },
  { code: "MY", name: "Malaysia",        region: "Asia Pacific" },
  { code: "ID", name: "Indonesia",       region: "Asia Pacific" },
  { code: "PH", name: "Philippines",     region: "Asia Pacific" },
  { code: "TH", name: "Thailand",        region: "Asia Pacific" },
  { code: "VN", name: "Vietnam",         region: "Asia Pacific" },
  { code: "PK", name: "Pakistan",        region: "Asia Pacific" },
  { code: "BD", name: "Bangladesh",      region: "Asia Pacific" },
  { code: "TW", name: "Taiwan",          region: "Asia Pacific" },
  { code: "HK", name: "Hong Kong",       region: "Asia Pacific" },
  { code: "LK", name: "Sri Lanka",       region: "Asia Pacific" },
  { code: "NP", name: "Nepal",           region: "Asia Pacific" },
  { code: "MM", name: "Myanmar",         region: "Asia Pacific" },

  // --- Middle East & Africa ------------------------------------------
  { code: "AE", name: "United Arab Emirates", region: "Middle East & Africa" },
  { code: "SA", name: "Saudi Arabia",    region: "Middle East & Africa" },
  { code: "IL", name: "Israel",          region: "Middle East & Africa" },
  { code: "EG", name: "Egypt",           region: "Middle East & Africa" },
  { code: "ZA", name: "South Africa",    region: "Middle East & Africa" },
  { code: "NG", name: "Nigeria",         region: "Middle East & Africa" },
  { code: "KE", name: "Kenya",           region: "Middle East & Africa" },
  { code: "MA", name: "Morocco",         region: "Middle East & Africa" },
  { code: "GH", name: "Ghana",           region: "Middle East & Africa" },
  { code: "ET", name: "Ethiopia",        region: "Middle East & Africa" },
  { code: "QA", name: "Qatar",           region: "Middle East & Africa" },
  { code: "KW", name: "Kuwait",          region: "Middle East & Africa" },
  { code: "JO", name: "Jordan",          region: "Middle East & Africa" },
  { code: "TN", name: "Tunisia",         region: "Middle East & Africa" },
  { code: "DZ", name: "Algeria",         region: "Middle East & Africa" },
  { code: "TZ", name: "Tanzania",        region: "Middle East & Africa" },
  { code: "UG", name: "Uganda",          region: "Middle East & Africa" },
  { code: "LB", name: "Lebanon",         region: "Middle East & Africa" },
  { code: "OM", name: "Oman",            region: "Middle East & Africa" },
  { code: "BH", name: "Bahrain",         region: "Middle East & Africa" },

  // --- CIS / Central Asia ---------------------------------------------
  { code: "RU", name: "Russia",          region: "CIS / Central Asia" },
  { code: "UA", name: "Ukraine",         region: "CIS / Central Asia" },
  { code: "KZ", name: "Kazakhstan",      region: "CIS / Central Asia" },
  { code: "UZ", name: "Uzbekistan",      region: "CIS / Central Asia" },
  { code: "BY", name: "Belarus",         region: "CIS / Central Asia" },
  { code: "AZ", name: "Azerbaijan",      region: "CIS / Central Asia" },
];
