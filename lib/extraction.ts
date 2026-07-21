import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import {
  SERVICE_TYPE_VALUES,
  FREQUENCY_VALUES,
  serviceLabel,
} from "./constants";
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
  frequency: z.string().nullable(),
  condition_notes: z.string().nullable(),
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
    frequency: { type: ["string", "null"] },
    condition_notes: { type: ["string", "null"] },
  },
  required: [
    "service_type",
    "property_size_m2",
    "postal_code",
    "city",
    "preferred_time",
    "frequency",
    "condition_notes",
  ],
} as const;

// The normalized, validated result the rest of the app consumes.
export type Extraction = {
  service_type: string | null;
  property_size_m2: number | null;
  postal_code: string | null;
  city: string | null;
  preferred_time: string | null;
  frequency: string | null;
  condition_notes: string | null;
  needs_clarification: boolean;
  clarification_reason: string | null;
};

const EXTRACTION_SYSTEM_PROMPT = `Olet Cleavan (siivouspalvelu) tiedon poimija. Saat asiakkaan vapaamuotoisen siivouspyynnön suomeksi. Tehtäväsi on poimia siitä jäsennellyt kentät.

EHDOTON SÄÄNTÖ: älä KOSKAAN keksi tai arvaa arvoa. Jos jotain ei ole selvästi kerrottu tai selkeästi pääteltävissä tekstistä, palauta sille null.

Kentät:
- service_type: palvelun tyyppi. Palauta täsmälleen yksi näistä koodeista tai null: ${SERVICE_TYPE_VALUES.join(", ")}. (kotisiivous = tavallinen kodin siivous, muuttosiivous = muuton yhteydessä, suursiivous = perusteellinen iso siivous, ikkunanpesu = ikkunat, toimistosiivous = toimisto, porrassiivous = porraskäytävä, erikoissiivous = esim. sauna/parveke/erikoiskohteet.)
- property_size_m2: kohteen pinta-ala neliömetreinä numerona (esim. 65). Vain jos koko on mainittu tai selvästi pääteltävissä. Muuten null. Älä arvaa huoneluvusta.
- postal_code: 5-numeroinen postinumero jos mainittu, muuten null.
- city: kaupunki/paikkakunta jos mainittu (esim. Helsinki, Espoo, Vantaa, Jyväskylä), muuten null.
- preferred_time: toivottu ajankohta asiakkaan omin sanoin (esim. "ensi viikolla", "15.8. aamupäivä"), muuten null.
- frequency: siivousväli. Palauta täsmälleen yksi näistä koodeista tai null: ${FREQUENCY_VALUES.join(", ")}. (kertaluontoinen = kertaluontoinen, viikoittain = viikoittain, joka_toinen_viikko = joka toinen viikko, kuukausittain = kuukausittain.)
- condition_notes: maininnat kunnosta, lemmikeistä, kulusta/avaimista, erikoistoiveista tai lisätöistä (esim. "kaksi kissaa", "uuni pestävä", "avain saatavilla ovimatolta"). Muuten null.

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
    messages: [{ role: "user", content: `SIIVOUSPYYNTÖ:\n${rawRequest}` }],
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

  return {
    service_type,
    property_size_m2,
    postal_code,
    city,
    preferred_time,
    frequency,
    condition_notes,
    needs_clarification,
    clarification_reason,
  };
}

// ---------------------------------------------------------------------------
// 2. Estimation — deterministic (no model). Given the extracted service type
//    and m², look up the matching time_estimates bracket for the on-site hour
//    range (single cleaner), then multiply by the resolved pricing rate to get
//    a price range. All arithmetic in code; the model never touches it.
// ---------------------------------------------------------------------------

export type Estimate = {
  hoursMin: number | null;
  hoursMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  // The matched estimation-guide bracket, if any.
  matchedBracket: TimeEstimate | null;
};

/**
 * Find the time_estimates bracket for a service + size. Bounds are half-open
 * [min, max): a size exactly on a shared boundary (e.g. 30 m² between 20–30 and
 * 30–40) lands deterministically in the upper bracket. Sizes below the smallest
 * bracket or at/above the largest bracket's max return null (→ fallback).
 */
export function lookupTimeEstimate(
  serviceType: string | null,
  m2: number | null,
  estimates: TimeEstimate[]
): TimeEstimate | null {
  if (!serviceType || m2 == null) return null;
  return (
    estimates.find(
      (e) =>
        e.service_type === serviceType &&
        m2 >= Number(e.size_min_m2) &&
        m2 < Number(e.size_max_m2)
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

  const empty: Estimate = {
    hoursMin: null,
    hoursMax: null,
    priceMin: null,
    priceMax: null,
    matchedBracket: bracket,
  };

  if (!bracket) return empty;

  const hoursMin = Math.max(Number(bracket.hours_min_1c), minHours);
  const hoursMax = Math.max(Number(bracket.hours_max_1c), minHours);

  if (!pricing.hasStandardRate || pricing.baseRate == null) {
    // We have an hour range but no fixed rate to price it against.
    return { hoursMin, hoursMax, priceMin: null, priceMax: null, matchedBracket: bracket };
  }

  return {
    hoursMin,
    hoursMax,
    priceMin: Math.round(pricing.baseRate * hoursMin),
    priceMax: Math.round(pricing.baseRate * hoursMax),
    matchedBracket: bracket,
  };
}

/** Human-readable Finnish summary of an estimate, for the drafting prompt. */
export function describeEstimate(
  serviceType: string | null,
  estimate: Estimate
): string {
  if (estimate.hoursMin == null || estimate.hoursMax == null) {
    return "Tuntiarviota ei voitu laskea (koko tai palvelu puuttuu, tai palvelulle ei ole arviotaulukkoa).";
  }
  const hours =
    estimate.hoursMin === estimate.hoursMax
      ? `${estimate.hoursMin} h`
      : `${estimate.hoursMin}–${estimate.hoursMax} h`;
  const price =
    estimate.priceMin != null && estimate.priceMax != null
      ? estimate.priceMin === estimate.priceMax
        ? `, arviohinta noin ${estimate.priceMin} €`
        : `, arviohinta noin ${estimate.priceMin}–${estimate.priceMax} €`
      : "";
  return `${serviceLabel(serviceType)}: arvioitu työaika ${hours}${price} (yksi siivooja).`;
}
