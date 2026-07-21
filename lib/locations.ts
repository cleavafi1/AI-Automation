// Deterministic Uusimaa lookup — NOT an AI guess.
//
// The Uusimaa travel-gap rule (a 1h buffer before/after adjacent appointments)
// depends on whether a job's location is in the Uusimaa region (the greater
// Helsinki capital area we serve) vs. the Jyväskylä area (no gap). We resolve
// this from a hardcoded table of the known service-area place names, matching
// on the extracted city first and the postal-code prefix as a backstop.

// Known service areas (from the established Cleava service areas).
const UUSIMAA_CITIES = new Set([
  "helsinki",
  "espoo",
  "vantaa",
  "kauniainen",
  "kirkkonummi",
  "kerava",
  "järvenpää",
  "jarvenpaa",
  "tuusula",
  "sipoo",
  "nurmijärvi",
  "nurmijarvi",
]);

const NON_UUSIMAA_CITIES = new Set([
  "jyväskylä",
  "jyvaskyla",
  "kuokkala",
  "palokka",
  "vaajakoski",
  "muurame",
]);

// Postal-code prefixes as a backstop when the city name is missing/unrecognized.
// Uusimaa postal codes are 00xxx–09xxx (plus a few 12xxx); the Jyväskylä region
// is 40xxx–41xxx. This is a coarse but deterministic fallback.
function uusimaaByPostal(postalCode: string): boolean | null {
  const p = postalCode.trim();
  if (!/^\d{5}$/.test(p)) return null;
  const prefix2 = p.slice(0, 2);
  if (prefix2 >= "00" && prefix2 <= "09") return true; // capital region
  if (prefix2 === "40" || prefix2 === "41") return false; // Jyväskylä region
  return null;
}

export type UusimaaResolution = {
  isUusimaa: boolean;
  // Whether we could positively identify the region (vs. defaulting).
  known: boolean;
};

/**
 * Resolve whether a location is in Uusimaa. Prefers the city name, falls back
 * to the postal-code prefix. When neither is recognized we DEFAULT to Uusimaa
 * (isUusimaa = true, known = false) — the conservative choice, since applying
 * the travel gap only spaces appointments out more; it never risks
 * double-booking travel time.
 */
export function resolveUusimaa(
  city: string | null | undefined,
  postalCode: string | null | undefined
): UusimaaResolution {
  const c = city?.trim().toLowerCase();
  if (c && UUSIMAA_CITIES.has(c)) return { isUusimaa: true, known: true };
  if (c && NON_UUSIMAA_CITIES.has(c)) return { isUusimaa: false, known: true };

  if (postalCode) {
    const byPostal = uusimaaByPostal(postalCode);
    if (byPostal !== null) return { isUusimaa: byPostal, known: true };
  }

  // Unknown location → conservative default.
  return { isUusimaa: true, known: false };
}
