import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import {
  SERVICE_TYPE_VALUES,
  FREQUENCY_VALUES,
  serviceLabel,
} from "./constants";
import { helsinkiTodayString } from "./timezone";
import type { ResolvedPricing } from "./pricing";
import type { TimeEstimate } from "./types";

// ---------------------------------------------------------------------------
// 1. Extraction — Claude reads the customer's free-text request and pulls out
//    structured fields. The model MUST NEVER invent a value: anything not
//    clearly stated is returned as null. needs_clarification is derived in code
//    (below) from what's missing — not trusted to the model.
// ---------------------------------------------------------------------------

// What the model returns. Every field is nullable; the model leaves a field
// null rather than guessing.
const RawExtractionSchema = z.object({
  service_type: z.string().nullable(),
  property_size_m2: z.number().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  preferred_time: z.string().nullable(),
  // Concrete, resolvable date/time only (see prompt) — vague terms stay null.
  requested_date: z.string().nullable(),
  requested_time: z.string().nullable(),
  frequency: z.string().nullable(),
  condition_notes: z.string().nullable(),
  // Billing address components (for invoicing).
  billing_street: z.string().nullable(),
  billing_building_number: z.string().nullable(),
  billing_apartment: z.string().nullable(),
});

type RawExtraction = z.infer<typeof RawExtractionSchema>;

const RAW_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    service_type: { type: ["string", "null"] },
    property_size_m2: { type: ["number", "null"] },
    postal_code: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    preferred_time: { type: ["string", "null"] },
    requested_date: { type: ["string", "null"] },
    requested_time: { type: ["string", "null"] },
    frequency: { type: ["string", "null"] },
    condition_notes: { type: ["string", "null"] },
    billing_street: { type: ["string", "null"] },
    billing_building_number: { type: ["string", "null"] },
    billing_apartment: { type: ["string", "null"] },
  },
  required: [
    "service_type",
    "property_size_m2",
    "postal_code",
    "city",
    "preferred_time",
    "requested_date",
    "requested_time",
    "frequency",
    "condition_notes",
    "billing_street",
    "billing_building_number",
    "billing_apartment",
  ],
} as const;

// The normalized, validated result the rest of the app consumes.
export type Extraction = {
  service_type: string | null;
  property_size_m2: number | null;
  postal_code: string | null;
  city: string | null;
  preferred_time: string | null;
  // Normalized concrete appointment request (Helsinki), for the slot finder.
  requested_date: string | null; // "YYYY-MM-DD"
  requested_time: string | null; // "HH:MM"
  frequency: string | null;
  condition_notes: string | null;
  needs_clarification: boolean;
  clarification_reason: string | null;
  // Billing address (for invoicing).
  billing_street: string | null;
  billing_building_number: string | null;
  billing_apartment: string | null;
  // True when the billing address is incomplete (street + building + postal).
  needs_billing_address: boolean;
};

const EXTRACTION_SYSTEM_PROMPT = `Olet Cleavan (siivouspalvelu) tiedon poimija. Saat asiakkaan vapaamuotoisen siivouspyynnön suomeksi. Tehtäväsi on poimia siitä jäsennellyt kentät.

EHDOTON SÄÄNTÖ: älä KOSKAAN keksi tai arvaa arvoa. Jos jotain ei ole selvästi kerrottu tai selkeästi pääteltävissä tekstistä, palauta sille null.

Kentät:
- service_type: palvelun tyyppi. Palauta täsmälleen yksi näistä koodeista tai null: ${SERVICE_TYPE_VALUES.join(", ")}. (kotisiivous = tavallinen kodin siivous, muuttosiivous = muuton yhteydessä, suursiivous = perusteellinen iso siivous, ikkunanpesu = ikkunat, toimistosiivous = toimisto, porrassiivous = porraskäytävä, erikoissiivous = esim. sauna/parveke/erikoiskohteet.)
- property_size_m2: kohteen pinta-ala neliömetreinä numerona (esim. 65). Vain jos koko on mainittu tai selvästi pääteltävissä. Muuten null. Älä arvaa huoneluvusta.
- postal_code: 5-numeroinen postinumero jos mainittu, muuten null.
- city: kaupunki/paikkakunta jos mainittu (esim. Helsinki, Espoo, Vantaa, Jyväskylä), muuten null.
- preferred_time: toivottu ajankohta asiakkaan omin sanoin (esim. "ensi viikolla", "15.8. aamupäivä"), muuten null.
- requested_date: TÄSMÄLLINEN toivottu päivä muodossa YYYY-MM-DD, VAIN jos asiakas antaa selkeän päivämäärän tai selvästi laskettavissa olevan päivän (esim. "15.8." → tämän vuoden 15. elokuuta, "ensi maanantaina" → laske alla annetusta tämän päivän päivämäärästä). Jos ajankohta on epämääräinen ("pian", "ensi viikolla", "elokuussa", "joskus"), palauta null — ÄLÄ arvaa tarkkaa päivää.
- requested_time: TÄSMÄLLINEN kellonaika muodossa HH:MM (24h), VAIN jos asiakas antaa selkeän ajan (esim. "klo 10", "aamupäivällä" → älä arvaa; vain jos tarkka). Muuten null.
- frequency: siivousväli. Palauta täsmälleen yksi näistä koodeista tai null: ${FREQUENCY_VALUES.join(", ")}. (kertaluontoinen = kertaluontoinen, viikoittain = viikoittain, joka_toinen_viikko = joka toinen viikko, kuukausittain = kuukausittain.)
- condition_notes: maininnat kunnosta, lemmikeistä, kulusta/avaimista, erikoistoiveista tai lisätöistä (esim. "kaksi kissaa", "uuni pestävä", "avain saatavilla ovimatolta"). Muuten null.
- billing_street: laskutusosoitteen kadunnimi jos mainittu (esim. "Mannerheimintie"), muuten null.
- billing_building_number: rakennuksen numero jos mainittu (esim. "5" tai "12 B"), muuten null.
- billing_apartment: asunnon/oven numero jos mainittu (esim. "A 12", "as. 7", "C 34"), muuten null.

Palauta pelkkä JSON annetun skeeman mukaisesti.`;

/** Run Claude extraction over the customer's free-text request. */
export async function extractFromRequest(
  rawRequest: string
): Promise<Extraction> {
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 1500,
    output_config: {
      format: { type: "json_schema", schema: RAW_EXTRACTION_JSON_SCHEMA },
    },
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Tämän päivän päivämäärä (Europe/Helsinki): ${helsinkiTodayString()}. Käytä tätä suhteellisten päivien laskemiseen.\n\nSIIVOUSPYYNTÖ:\n${rawRequest}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to extract from this request.");
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let raw: RawExtraction;
  try {
    raw = RawExtractionSchema.parse(JSON.parse(rawText));
  } catch (err) {
    throw new Error(
      `Extraction did not return valid JSON (stop_reason: ${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return normalizeExtraction(raw);
}

// Validate + normalize the model output, then derive needs_clarification in
// code. Anything the model returned that isn't a recognized value is coerced to
// null (defence against the model inventing an out-of-set value).
export function normalizeExtraction(raw: RawExtraction): Extraction {
  const service_type =
    raw.service_type &&
    (SERVICE_TYPE_VALUES as readonly string[]).includes(raw.service_type)
      ? raw.service_type
      : null;

  const frequency =
    raw.frequency &&
    (FREQUENCY_VALUES as readonly string[]).includes(raw.frequency)
      ? raw.frequency
      : null;

  const property_size_m2 =
    raw.property_size_m2 != null &&
    Number.isFinite(raw.property_size_m2) &&
    raw.property_size_m2 > 0
      ? raw.property_size_m2
      : null;

  const postal_code =
    raw.postal_code && /^\d{5}$/.test(raw.postal_code.trim())
      ? raw.postal_code.trim()
      : null;

  const city = raw.city && raw.city.trim() ? raw.city.trim() : null;
  const preferred_time =
    raw.preferred_time && raw.preferred_time.trim()
      ? raw.preferred_time.trim()
      : null;
  const condition_notes =
    raw.condition_notes && raw.condition_notes.trim()
      ? raw.condition_notes.trim()
      : null;

  // Accept requested_date/time only in strict formats — otherwise null (the
  // slot finder then falls back to nearest-available). Guards against the model
  // returning a vague string where a strict date/time was asked for.
  const requested_date =
    raw.requested_date && /^\d{4}-\d{2}-\d{2}$/.test(raw.requested_date.trim())
      ? raw.requested_date.trim()
      : null;
  const requested_time =
    raw.requested_time && /^\d{1,2}:\d{2}$/.test(raw.requested_time.trim())
      ? raw.requested_time.trim().padStart(5, "0")
      : null;

  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const billing_street = clean(raw.billing_street);
  const billing_building_number = clean(raw.billing_building_number);
  const billing_apartment = clean(raw.billing_apartment);

  // needs_clarification: true when service type, size, OR location can't be
  // determined (location = postal code or city). Reason is code-built.
  const missing: string[] = [];
  if (!service_type) missing.push("palvelun tyyppi");
  if (property_size_m2 == null) missing.push("kohteen koko (m²)");
  if (!postal_code && !city) missing.push("sijainti");

  const needs_clarification = missing.length > 0;
  const clarification_reason = needs_clarification
    ? `Pyynnöstä ei voitu päätellä: ${missing.join(", ")}.`
    : null;

  // A billing address is complete enough to invoice when we have the street,
  // the building number and a postal code (apartment is optional for houses).
  const needs_billing_address = !(
    billing_street &&
    billing_building_number &&
    postal_code
  );

  return {
    service_type,
    property_size_m2,
    postal_code,
    city,
    preferred_time,
    requested_date,
    requested_time,
    frequency,
    condition_notes,
    needs_clarification,
    clarification_reason,
    billing_street,
    billing_building_number,
    billing_apartment,
    needs_billing_address,
  };
}

// ---------------------------------------------------------------------------
// 2. Estimation — deterministic (no model). Given the extracted service type
//    and m², look up the matching time_estimates bracket for the on-site hour
//    range (single cleaner), then multiply by the resolved pricing rate to get
//    a price range. All arithmetic in code; the model never touches it.
// ---------------------------------------------------------------------------

// Kotitalousvähennys: 35 % of the labour cost, capped at €1,600 / year / person.
export const KOTITALOUSVAHENNYS_RATE = 0.35;
const KOTITALOUSVAHENNYS_MAX = 1600;

/**
 * Number of cleaners we send, by size — the client's fixed business rule
 * (matches the estimation guide's column structure):
 *   < 30 m²        → 1 cleaner  (not mentioned to the customer)
 *   30–under 100   → 2 cleaners (mentioned)
 *   100 m² and up  → 3 cleaners (mentioned)
 * Price is unaffected (total work-hours × rate); more cleaners just finish the
 * same total work faster (wall-clock = total ÷ cleaners).
 */
export function cleanerCountForM2(m2: number | null): number {
  if (m2 == null) return 1;
  if (m2 < 30) return 1;
  if (m2 < 100) return 2;
  return 3;
}

/** Net price after kotitalousvähennys (35 %, capped), rounded. */
export function netAfterDeduction(price: number): number {
  const deduction = Math.min(price * KOTITALOUSVAHENNYS_RATE, KOTITALOUSVAHENNYS_MAX);
  return Math.round(price - deduction);
}

export type Estimate = {
  // Total work-hours (single cleaner) — the price basis.
  hoursMin: number | null;
  hoursMax: number | null;
  // Price = total work-hours × rate (unchanged by cleaner count).
  priceMin: number | null;
  priceMax: number | null;
  // Net price to the customer after kotitalousvähennys (home services).
  netPriceMin: number | null;
  netPriceMax: number | null;
  // Cleaners sent, and the resulting on-site wall-clock time (total ÷ cleaners).
  cleaners: number;
  finishHoursMin: number | null;
  finishHoursMax: number | null;
  // The matched estimation-guide bracket, if any.
  matchedBracket: TimeEstimate | null;
};

/**
 * Find the time_estimates bracket for a service + size. Bounds are
 * inclusive-lower: a size exactly on a shared boundary (e.g. 30 m² between
 * 20–30 and 30–40) lands in the LOWER bracket (20–30). Implemented as (min,
 * max], with a fallback so the smallest bracket still includes its own min
 * (e.g. exactly 20 m²). Order-independent. Sizes above the largest bracket's
 * max return null (→ fallback).
 */
export function lookupTimeEstimate(
  serviceType: string | null,
  m2: number | null,
  estimates: TimeEstimate[]
): TimeEstimate | null {
  if (!serviceType || m2 == null) return null;
  const forService = estimates.filter((e) => e.service_type === serviceType);
  // Primary: (min, max] — a boundary value matches the bracket it's the max of.
  const primary = forService.find(
    (e) => m2 > Number(e.size_min_m2) && m2 <= Number(e.size_max_m2)
  );
  if (primary) return primary;
  // Fallback: value equal to the smallest bracket's min (no lower neighbour).
  return (
    forService.find(
      (e) => m2 >= Number(e.size_min_m2) && m2 <= Number(e.size_max_m2)
    ) ?? null
  );
}

/**
 * Compute the hour + price estimate for an inquiry. Returns nulls when the
 * service type / size is unknown or no bracket matches (e.g. size out of the
 * guide's range, or a service with a rate but no estimation brackets such as
 * suursiivous). Price = rate × hours, with a minimum-order floor applied.
 */
export function computeEstimate(
  serviceType: string | null,
  m2: number | null,
  pricing: ResolvedPricing,
  estimates: TimeEstimate[],
  minHours: number
): Estimate {
  const bracket = lookupTimeEstimate(serviceType, m2, estimates);
  const cleaners = cleanerCountForM2(m2);

  const empty: Estimate = {
    hoursMin: null,
    hoursMax: null,
    priceMin: null,
    priceMax: null,
    netPriceMin: null,
    netPriceMax: null,
    cleaners,
    finishHoursMin: null,
    finishHoursMax: null,
    matchedBracket: bracket,
  };

  if (!bracket) return empty;

  const hoursMin = Math.max(Number(bracket.hours_min_1c), minHours);
  const hoursMax = Math.max(Number(bracket.hours_max_1c), minHours);

  // On-site wall-clock time = total work-hours ÷ cleaners (rounded to 0.5h),
  // still respecting the minimum-order floor.
  const roundHalf = (h: number) => Math.max(Math.round(h * 2) / 2, minHours);
  const finishHoursMin = roundHalf(hoursMin / cleaners);
  const finishHoursMax = roundHalf(hoursMax / cleaners);

  if (!pricing.hasStandardRate || pricing.baseRate == null) {
    // We have an hour range but no fixed rate to price it against.
    return {
      ...empty,
      hoursMin,
      hoursMax,
      finishHoursMin,
      finishHoursMax,
    };
  }

  const priceMin = Math.round(pricing.baseRate * hoursMin);
  const priceMax = Math.round(pricing.baseRate * hoursMax);

  return {
    hoursMin,
    hoursMax,
    priceMin,
    priceMax,
    netPriceMin: netAfterDeduction(priceMin),
    netPriceMax: netAfterDeduction(priceMax),
    cleaners,
    finishHoursMin,
    finishHoursMax,
    matchedBracket: bracket,
  };
}

function fmtRange(min: number, max: number, unit: string): string {
  return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

/** Human-readable Finnish summary of an estimate, for the drafting prompt. */
export function describeEstimate(
  serviceType: string | null,
  estimate: Estimate
): string {
  if (estimate.hoursMin == null || estimate.hoursMax == null) {
    return "Tuntiarviota ei voitu laskea (koko tai palvelu puuttuu, tai palvelulle ei ole arviotaulukkoa).";
  }
  const lines: string[] = [];
  lines.push(
    `${serviceLabel(serviceType)}: kokonaistyöaika ${fmtRange(
      estimate.hoursMin,
      estimate.hoursMax,
      "h"
    )} (hinnan peruste; yhden siivoojan työtunnit yhteensä).`
  );
  if (estimate.priceMin != null && estimate.priceMax != null) {
    lines.push(`Arviohinta: noin ${fmtRange(estimate.priceMin, estimate.priceMax, "€")}.`);
  }
  if (estimate.netPriceMin != null && estimate.netPriceMax != null) {
    lines.push(
      `Kotitalousvähennyksen jälkeen (35 %): noin ${fmtRange(
        estimate.netPriceMin,
        estimate.netPriceMax,
        "€"
      )}.`
    );
  }
  if (
    estimate.cleaners >= 2 &&
    estimate.finishHoursMin != null &&
    estimate.finishHoursMax != null
  ) {
    lines.push(
      `Lähetämme ${estimate.cleaners} siivoojaa, jolloin työ valmistuu paikan päällä noin ${fmtRange(
        estimate.finishHoursMin,
        estimate.finishHoursMax,
        "tunnissa"
      )} (hinta pysyy samana, koska se perustuu kokonaistyötunteihin).`
    );
  }
  return lines.join(" ");
}
