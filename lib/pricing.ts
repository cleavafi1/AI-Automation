import { isQuoteOnlyService } from "./constants";
import type { Inquiry, PricingTier } from "./types";

export type ResolvedPricing = {
  rateType: "hourly" | "quote_only";
  baseRate: number | null;
  tierLabel: string | null;
  tierNotes: string | null;
  // True only when we have a concrete hourly rate to quote against.
  hasStandardRate: boolean;
  // Set when a normally-hourly service has no matching tier for this inquiry
  // (e.g. one-time kotisiivous, which has no fixed rate) — a flag reason.
  noRateReason: string | null;
};

// kotisiivous is the only service whose rate depends on frequency; its tiers
// are labelled by frequency value.
const FREQUENCY_KEYED_SERVICES = new Set(["kotisiivous"]);

// Fallback on-site hours per property-size bucket, used when the model doesn't
// supply an estimate for a fixed-rate service. Rough starting points for a
// single visit — the quote is still flagged for review, but the reviewer sees
// a number rather than nothing. All at or above the 2h minimum order.
const DEFAULT_HOURS_BY_SIZE: Record<string, number> = {
  alle_35: 2,
  "35_49": 2,
  "50_64": 2.5,
  "65_79": 3,
  "80_99": 3.5,
  "100_119": 4,
  "120_149": 5,
  "150_199": 6,
  "200_plus": 7,
};

/** Fallback hour estimate for a property size (defaults to 2h if unknown). */
export function fallbackHoursForSize(propertySize: string): number {
  return DEFAULT_HOURS_BY_SIZE[propertySize] ?? 2;
}

/**
 * Resolve the applicable pricing for an inquiry from the seeded pricing_tiers.
 * Deterministic — no AI involved — so price/rate facts can't be hallucinated.
 */
export function resolvePricing(
  inquiry: Inquiry,
  tiers: PricingTier[]
): ResolvedPricing {
  const serviceTiers = tiers.filter(
    (t) => t.service_type === inquiry.service_type
  );

  // Always quote-only services (office/stairwell/special).
  if (isQuoteOnlyService(inquiry.service_type)) {
    return {
      rateType: "quote_only",
      baseRate: null,
      tierLabel: null,
      tierNotes: serviceTiers[0]?.notes ?? null,
      hasStandardRate: false,
      noRateReason: null,
    };
  }

  // Frequency-keyed hourly services (kotisiivous): match tier by frequency.
  if (FREQUENCY_KEYED_SERVICES.has(inquiry.service_type)) {
    const match = serviceTiers.find((t) => t.tier_label === inquiry.frequency);
    if (match && match.base_rate_eur != null) {
      return {
        rateType: "hourly",
        baseRate: Number(match.base_rate_eur),
        tierLabel: match.tier_label,
        tierNotes: match.notes,
        hasStandardRate: true,
        noRateReason: null,
      };
    }
    // No matching frequency tier (e.g. kertaluontoinen kotisiivous).
    return {
      rateType: "hourly",
      baseRate: null,
      tierLabel: null,
      tierNotes: null,
      hasStandardRate: false,
      noRateReason:
        "Tälle siivousvälille ei ole vakiotuntihintaa — vaatii erillisen tarjouksen.",
    };
  }

  // Single-tier hourly services (ikkunanpesu, suursiivous, muuttosiivous).
  const hourly = serviceTiers.find((t) => t.rate_type === "hourly");
  if (hourly && hourly.base_rate_eur != null) {
    return {
      rateType: "hourly",
      baseRate: Number(hourly.base_rate_eur),
      tierLabel: hourly.tier_label,
      tierNotes: hourly.notes,
      hasStandardRate: true,
      noRateReason: null,
    };
  }

  // Fallback: service configured but no usable rate found → needs a quote.
  return {
    rateType: serviceTiers[0]?.rate_type ?? "quote_only",
    baseRate: null,
    tierLabel: null,
    tierNotes: serviceTiers[0]?.notes ?? null,
    hasStandardRate: false,
    noRateReason:
      "Palvelulle ei löytynyt kiinteää tuntihintaa — vaatii erillisen tarjouksen.",
  };
}
