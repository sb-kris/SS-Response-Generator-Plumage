// Approximate lat/lng for every city in `language-geography.ts`.
// Two-decimal precision is plenty — the Faker layer adds ±0.5° jitter on top
// so personas don't all stack on the exact same point.
//
// Coordinates are well-known city centers (rounded). If a city is missing,
// `getCityCoordinates` falls back to the country center.

export interface LatLng {
  latitude: number;
  longitude: number;
}

// City -> coords. Keys are case-sensitive and match the strings used in
// `language-geography.ts` exactly.
const CITY_COORDS: Record<string, LatLng> = {
  // ---- United States ----
  "New York": { latitude: 40.71, longitude: -74.0 },
  "Los Angeles": { latitude: 34.05, longitude: -118.24 },
  Chicago: { latitude: 41.88, longitude: -87.63 },
  Houston: { latitude: 29.76, longitude: -95.37 },
  Phoenix: { latitude: 33.45, longitude: -112.07 },
  Philadelphia: { latitude: 39.95, longitude: -75.17 },

  // ---- United Kingdom ----
  London: { latitude: 51.51, longitude: -0.13 },
  Manchester: { latitude: 53.48, longitude: -2.24 },
  Birmingham: { latitude: 52.49, longitude: -1.89 },
  Glasgow: { latitude: 55.86, longitude: -4.25 },
  Liverpool: { latitude: 53.41, longitude: -2.99 },
  Edinburgh: { latitude: 55.95, longitude: -3.19 },

  // ---- Canada ----
  Toronto: { latitude: 43.65, longitude: -79.38 },
  Vancouver: { latitude: 49.28, longitude: -123.12 },
  Calgary: { latitude: 51.05, longitude: -114.07 },
  Ottawa: { latitude: 45.42, longitude: -75.7 },
  Edmonton: { latitude: 53.55, longitude: -113.49 },
  Winnipeg: { latitude: 49.9, longitude: -97.14 },
  Montréal: { latitude: 45.5, longitude: -73.57 },
  "Québec City": { latitude: 46.81, longitude: -71.21 },
  Gatineau: { latitude: 45.48, longitude: -75.7 },
  Sherbrooke: { latitude: 45.4, longitude: -71.89 },
  "Trois-Rivières": { latitude: 46.34, longitude: -72.55 },
  Laval: { latitude: 45.61, longitude: -73.71 },

  // ---- Australia ----
  Sydney: { latitude: -33.87, longitude: 151.21 },
  Melbourne: { latitude: -37.81, longitude: 144.96 },
  Brisbane: { latitude: -27.47, longitude: 153.03 },
  Perth: { latitude: -31.95, longitude: 115.86 },
  Adelaide: { latitude: -34.93, longitude: 138.6 },
  Hobart: { latitude: -42.88, longitude: 147.33 },

  // ---- India ----
  Mumbai: { latitude: 19.08, longitude: 72.88 },
  Bengaluru: { latitude: 12.97, longitude: 77.59 },
  Delhi: { latitude: 28.61, longitude: 77.21 },
  Chennai: { latitude: 13.08, longitude: 80.27 },
  Hyderabad: { latitude: 17.39, longitude: 78.49 },
  Pune: { latitude: 18.52, longitude: 73.86 },
  Lucknow: { latitude: 26.85, longitude: 80.95 },
  Kanpur: { latitude: 26.45, longitude: 80.33 },
  Patna: { latitude: 25.59, longitude: 85.14 },
  Jaipur: { latitude: 26.92, longitude: 75.79 },
  Indore: { latitude: 22.72, longitude: 75.86 },
  Nagpur: { latitude: 21.15, longitude: 79.09 },

  // ---- Ireland ----
  Dublin: { latitude: 53.35, longitude: -6.26 },
  Cork: { latitude: 51.9, longitude: -8.47 },
  Galway: { latitude: 53.27, longitude: -9.05 },
  Limerick: { latitude: 52.66, longitude: -8.62 },

  // ---- Mexico ----
  "Mexico City": { latitude: 19.43, longitude: -99.13 },
  Guadalajara: { latitude: 20.66, longitude: -103.35 },
  Monterrey: { latitude: 25.69, longitude: -100.32 },
  Puebla: { latitude: 19.04, longitude: -98.21 },
  Tijuana: { latitude: 32.51, longitude: -117.04 },
  León: { latitude: 21.13, longitude: -101.67 },

  // ---- Spain ----
  Madrid: { latitude: 40.42, longitude: -3.7 },
  Barcelona: { latitude: 41.39, longitude: 2.16 },
  Valencia: { latitude: 39.47, longitude: -0.38 },
  Sevilla: { latitude: 37.39, longitude: -5.99 },
  Zaragoza: { latitude: 41.65, longitude: -0.88 },
  Málaga: { latitude: 36.72, longitude: -4.42 },

  // ---- Argentina ----
  "Buenos Aires": { latitude: -34.6, longitude: -58.38 },
  Córdoba: { latitude: -31.42, longitude: -64.18 },
  Rosario: { latitude: -32.95, longitude: -60.66 },
  Mendoza: { latitude: -32.89, longitude: -68.84 },
  "La Plata": { latitude: -34.92, longitude: -57.95 },
  "Mar del Plata": { latitude: -38.0, longitude: -57.55 },

  // ---- Colombia ----
  Bogotá: { latitude: 4.71, longitude: -74.07 },
  Medellín: { latitude: 6.25, longitude: -75.56 },
  Cali: { latitude: 3.45, longitude: -76.53 },
  Barranquilla: { latitude: 10.96, longitude: -74.78 },
  Cartagena: { latitude: 10.39, longitude: -75.51 },
  Bucaramanga: { latitude: 7.12, longitude: -73.13 },

  // ---- Chile ----
  Santiago: { latitude: -33.45, longitude: -70.66 },
  Valparaíso: { latitude: -33.05, longitude: -71.62 },
  Concepción: { latitude: -36.83, longitude: -73.05 },
  "Viña del Mar": { latitude: -33.02, longitude: -71.55 },
  Antofagasta: { latitude: -23.65, longitude: -70.4 },
  "La Serena": { latitude: -29.9, longitude: -71.25 },

  // ---- Peru ----
  Lima: { latitude: -12.05, longitude: -77.04 },
  Arequipa: { latitude: -16.41, longitude: -71.54 },
  Trujillo: { latitude: -8.11, longitude: -79.03 },
  Chiclayo: { latitude: -6.77, longitude: -79.84 },
  Cusco: { latitude: -13.53, longitude: -71.97 },
  Piura: { latitude: -5.19, longitude: -80.63 },

  // ---- France ----
  Paris: { latitude: 48.86, longitude: 2.35 },
  Marseille: { latitude: 43.3, longitude: 5.37 },
  Lyon: { latitude: 45.76, longitude: 4.84 },
  Toulouse: { latitude: 43.6, longitude: 1.44 },
  Nice: { latitude: 43.71, longitude: 7.26 },
  Nantes: { latitude: 47.22, longitude: -1.55 },
  Bordeaux: { latitude: 44.84, longitude: -0.58 },

  // ---- Belgium ----
  Brussels: { latitude: 50.85, longitude: 4.35 },
  Liège: { latitude: 50.63, longitude: 5.57 },
  Charleroi: { latitude: 50.41, longitude: 4.44 },
  Namur: { latitude: 50.47, longitude: 4.87 },
  Mons: { latitude: 50.45, longitude: 3.95 },
  Antwerp: { latitude: 51.22, longitude: 4.4 },
  Ghent: { latitude: 51.05, longitude: 3.72 },
  Bruges: { latitude: 51.21, longitude: 3.22 },
  Leuven: { latitude: 50.88, longitude: 4.7 },
  Mechelen: { latitude: 51.03, longitude: 4.48 },

  // ---- Switzerland ----
  Geneva: { latitude: 46.2, longitude: 6.15 },
  Lausanne: { latitude: 46.52, longitude: 6.63 },
  Lucerne: { latitude: 47.05, longitude: 8.31 },
  Bern: { latitude: 46.95, longitude: 7.45 },
  Fribourg: { latitude: 46.8, longitude: 7.15 },
  Zürich: { latitude: 47.38, longitude: 8.54 },
  Basel: { latitude: 47.56, longitude: 7.59 },
  "St. Gallen": { latitude: 47.42, longitude: 9.38 },
  Lugano: { latitude: 46.0, longitude: 8.95 },
  Bellinzona: { latitude: 46.19, longitude: 9.02 },
  Locarno: { latitude: 46.17, longitude: 8.79 },
  Mendrisio: { latitude: 45.87, longitude: 8.98 },

  // ---- Morocco ----
  Casablanca: { latitude: 33.57, longitude: -7.59 },
  Rabat: { latitude: 34.02, longitude: -6.83 },
  Marrakech: { latitude: 31.63, longitude: -8.0 },
  Fès: { latitude: 34.02, longitude: -5.0 },
  Tangier: { latitude: 35.76, longitude: -5.83 },

  // ---- Brazil ----
  "São Paulo": { latitude: -23.55, longitude: -46.63 },
  "Rio de Janeiro": { latitude: -22.91, longitude: -43.17 },
  Brasília: { latitude: -15.78, longitude: -47.93 },
  Salvador: { latitude: -12.97, longitude: -38.5 },
  Fortaleza: { latitude: -3.72, longitude: -38.54 },
  "Belo Horizonte": { latitude: -19.92, longitude: -43.94 },

  // ---- Portugal ----
  Lisbon: { latitude: 38.72, longitude: -9.13 },
  Porto: { latitude: 41.16, longitude: -8.62 },
  Braga: { latitude: 41.55, longitude: -8.43 },
  Coimbra: { latitude: 40.21, longitude: -8.43 },
  Aveiro: { latitude: 40.64, longitude: -8.65 },
  Faro: { latitude: 37.02, longitude: -7.93 },

  // ---- Germany ----
  Berlin: { latitude: 52.52, longitude: 13.4 },
  Hamburg: { latitude: 53.55, longitude: 10.0 },
  München: { latitude: 48.14, longitude: 11.58 },
  Köln: { latitude: 50.94, longitude: 6.96 },
  Frankfurt: { latitude: 50.11, longitude: 8.68 },
  Stuttgart: { latitude: 48.78, longitude: 9.18 },
  Dresden: { latitude: 51.05, longitude: 13.74 },

  // ---- Austria ----
  Vienna: { latitude: 48.21, longitude: 16.37 },
  Graz: { latitude: 47.07, longitude: 15.44 },
  Linz: { latitude: 48.31, longitude: 14.29 },
  Salzburg: { latitude: 47.81, longitude: 13.04 },
  Innsbruck: { latitude: 47.27, longitude: 11.39 },

  // ---- Japan ----
  Tokyo: { latitude: 35.68, longitude: 139.69 },
  Osaka: { latitude: 34.69, longitude: 135.5 },
  Yokohama: { latitude: 35.44, longitude: 139.64 },
  Nagoya: { latitude: 35.18, longitude: 136.91 },
  Sapporo: { latitude: 43.07, longitude: 141.35 },
  Kobe: { latitude: 34.69, longitude: 135.2 },
  Kyoto: { latitude: 35.01, longitude: 135.77 },
  Fukuoka: { latitude: 33.59, longitude: 130.4 },

  // ---- China ----
  Beijing: { latitude: 39.9, longitude: 116.41 },
  Shanghai: { latitude: 31.23, longitude: 121.47 },
  Guangzhou: { latitude: 23.13, longitude: 113.26 },
  Shenzhen: { latitude: 22.54, longitude: 114.06 },
  Chengdu: { latitude: 30.57, longitude: 104.07 },
  Hangzhou: { latitude: 30.27, longitude: 120.16 },
  Wuhan: { latitude: 30.59, longitude: 114.31 },

  // ---- Taiwan ----
  Taipei: { latitude: 25.03, longitude: 121.57 },
  Kaohsiung: { latitude: 22.63, longitude: 120.3 },
  Taichung: { latitude: 24.15, longitude: 120.67 },
  Tainan: { latitude: 22.99, longitude: 120.21 },
  Taoyuan: { latitude: 24.99, longitude: 121.31 },

  // ---- Hong Kong ----
  "Hong Kong": { latitude: 22.32, longitude: 114.17 },
  Kowloon: { latitude: 22.32, longitude: 114.18 },
  "New Territories": { latitude: 22.43, longitude: 114.07 },

  // ---- Singapore ----
  Singapore: { latitude: 1.35, longitude: 103.82 },

  // ---- Saudi Arabia ----
  Riyadh: { latitude: 24.71, longitude: 46.68 },
  Jeddah: { latitude: 21.49, longitude: 39.18 },
  Mecca: { latitude: 21.39, longitude: 39.86 },
  Medina: { latitude: 24.47, longitude: 39.61 },
  Dammam: { latitude: 26.43, longitude: 50.1 },

  // ---- Egypt ----
  Cairo: { latitude: 30.04, longitude: 31.24 },
  Alexandria: { latitude: 31.2, longitude: 29.92 },
  Giza: { latitude: 30.01, longitude: 31.21 },
  "Sharm El Sheikh": { latitude: 27.92, longitude: 34.33 },
  Luxor: { latitude: 25.69, longitude: 32.64 },

  // ---- UAE ----
  Dubai: { latitude: 25.2, longitude: 55.27 },
  "Abu Dhabi": { latitude: 24.45, longitude: 54.38 },
  Sharjah: { latitude: 25.35, longitude: 55.42 },
  Ajman: { latitude: 25.41, longitude: 55.44 },
  Fujairah: { latitude: 25.13, longitude: 56.34 },

  // ---- Jordan ----
  Amman: { latitude: 31.95, longitude: 35.93 },
  Zarqa: { latitude: 32.07, longitude: 36.09 },
  Irbid: { latitude: 32.55, longitude: 35.85 },
  Aqaba: { latitude: 29.53, longitude: 35.0 },

  // ---- Kuwait ----
  "Kuwait City": { latitude: 29.38, longitude: 47.99 },
  Hawalli: { latitude: 29.33, longitude: 48.03 },
  Salmiya: { latitude: 29.34, longitude: 48.08 },

  // ---- Italy ----
  Rome: { latitude: 41.9, longitude: 12.5 },
  Milan: { latitude: 45.46, longitude: 9.19 },
  Naples: { latitude: 40.85, longitude: 14.27 },
  Turin: { latitude: 45.07, longitude: 7.69 },
  Florence: { latitude: 43.77, longitude: 11.26 },
  Bologna: { latitude: 44.49, longitude: 11.34 },
  Venice: { latitude: 45.44, longitude: 12.32 },

  // ---- Netherlands ----
  Amsterdam: { latitude: 52.37, longitude: 4.9 },
  Rotterdam: { latitude: 51.92, longitude: 4.48 },
  "The Hague": { latitude: 52.07, longitude: 4.3 },
  Utrecht: { latitude: 52.09, longitude: 5.12 },
  Eindhoven: { latitude: 51.44, longitude: 5.48 },
  Groningen: { latitude: 53.22, longitude: 6.57 },

  // ---- South Korea ----
  Seoul: { latitude: 37.57, longitude: 126.98 },
  Busan: { latitude: 35.18, longitude: 129.08 },
  Incheon: { latitude: 37.46, longitude: 126.71 },
  Daegu: { latitude: 35.87, longitude: 128.6 },
  Daejeon: { latitude: 36.35, longitude: 127.38 },
  Gwangju: { latitude: 35.16, longitude: 126.85 },
  Suwon: { latitude: 37.26, longitude: 127.03 },

  // ---- Russia ----
  Moscow: { latitude: 55.76, longitude: 37.62 },
  "Saint Petersburg": { latitude: 59.93, longitude: 30.34 },
  Novosibirsk: { latitude: 55.04, longitude: 82.93 },
  Yekaterinburg: { latitude: 56.84, longitude: 60.61 },
  "Nizhny Novgorod": { latitude: 56.33, longitude: 44.0 },
  Kazan: { latitude: 55.79, longitude: 49.12 },

  // ---- Kazakhstan ----
  Almaty: { latitude: 43.26, longitude: 76.93 },
  Astana: { latitude: 51.17, longitude: 71.45 },
  Shymkent: { latitude: 42.32, longitude: 69.59 },
  Karaganda: { latitude: 49.81, longitude: 73.09 },

  // ---- Belarus ----
  Minsk: { latitude: 53.9, longitude: 27.57 },
  Gomel: { latitude: 52.43, longitude: 31.0 },
  Mogilev: { latitude: 53.9, longitude: 30.34 },
  Vitebsk: { latitude: 55.18, longitude: 30.2 },
};

// Country center fallback for cities not explicitly listed (shouldn't happen
// in practice, but defensive).
const COUNTRY_CENTERS: Record<string, LatLng> = {
  US: { latitude: 39.83, longitude: -98.58 },
  GB: { latitude: 54.0, longitude: -2.0 },
  CA: { latitude: 56.13, longitude: -106.35 },
  AU: { latitude: -25.27, longitude: 133.78 },
  IN: { latitude: 20.59, longitude: 78.96 },
  IE: { latitude: 53.41, longitude: -8.24 },
  MX: { latitude: 23.63, longitude: -102.55 },
  ES: { latitude: 40.46, longitude: -3.75 },
  AR: { latitude: -38.42, longitude: -63.62 },
  CO: { latitude: 4.57, longitude: -74.3 },
  CL: { latitude: -35.68, longitude: -71.54 },
  PE: { latitude: -9.19, longitude: -75.02 },
  FR: { latitude: 46.23, longitude: 2.21 },
  BE: { latitude: 50.5, longitude: 4.47 },
  CH: { latitude: 46.82, longitude: 8.23 },
  MA: { latitude: 31.79, longitude: -7.09 },
  BR: { latitude: -14.24, longitude: -51.93 },
  PT: { latitude: 39.4, longitude: -8.22 },
  DE: { latitude: 51.17, longitude: 10.45 },
  AT: { latitude: 47.52, longitude: 14.55 },
  JP: { latitude: 36.2, longitude: 138.25 },
  CN: { latitude: 35.86, longitude: 104.2 },
  TW: { latitude: 23.7, longitude: 121.0 },
  HK: { latitude: 22.32, longitude: 114.17 },
  SG: { latitude: 1.35, longitude: 103.82 },
  SA: { latitude: 23.89, longitude: 45.08 },
  EG: { latitude: 26.82, longitude: 30.8 },
  AE: { latitude: 23.42, longitude: 53.85 },
  JO: { latitude: 30.59, longitude: 36.24 },
  KW: { latitude: 29.31, longitude: 47.48 },
  IT: { latitude: 41.87, longitude: 12.57 },
  NL: { latitude: 52.13, longitude: 5.29 },
  KR: { latitude: 35.91, longitude: 127.77 },
  RU: { latitude: 61.52, longitude: 105.32 },
  KZ: { latitude: 48.02, longitude: 66.92 },
  BY: { latitude: 53.71, longitude: 27.95 },
};

const DEFAULT_CENTER: LatLng = { latitude: 0, longitude: 0 };

/**
 * Look up coordinates for a city. Falls back to the country center, then to
 * (0, 0) if neither is known. Callers should add jitter on top.
 */
export function getCityCoordinates(city: string, countryCode: string): LatLng {
  const direct = CITY_COORDS[city];
  if (direct) return direct;
  const center = COUNTRY_CENTERS[countryCode.toUpperCase()];
  if (center) return center;
  return DEFAULT_CENTER;
}
