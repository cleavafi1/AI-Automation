import { resolvePricing, type ResolvedPricing } from "./pricing";
import { computeEstimate, type Estimate } from "./extraction";
import { normalizeHHMM } from "./timezone";
import { getSupabaseAdmin } from "./supabase";
import type { Inquiry, PricingTier, Quote, TimeEstimate } from "./types";

const MIN_HOURS = 2;

/**
 * Deterministic hour/price estimate + resolved pricing for an inquiry, loaded
 * from the same pricing_tiers + time_estimates the original offer used. Shared
 * by the reserve-hours helper and the reply flow (so a reply can restate the
 * exact same duration/price facts as the offer).
 */
export async function computeEstimateForInquiry(
  inquiry: Inquiry
): Promise<{ estimate: Estimate; pricing: ResolvedPricing }> {
  const supabase = getSupabaseAdmin();
  const { data: tiers } = await supabase
    .from("pricing_tiers")
    .select("*")
    .eq("service_type", inquiry.service_type ?? "");
  const pricing = resolvePricing(inquiry, (tiers ?? []) as PricingTier[]);
  const { data: estRows } = await supabase
    .from("time_estimates")
    .select("*")
    .eq("service_type", inquiry.service_type ?? "");
  const estimate = computeEstimate(
    inquiry.service_type,
    inquiry.property_size_m2,
    pricing,
    (estRows ?? []) as TimeEstimate[],
    MIN_HOURS
  );
  return { estimate, pricing };
}

/**
 * Wall-clock hours to reserve when (re)checking availability for a quote.
 * Prefers the current proposed slot's length; otherwise recomputes from the
 * pricing + estimation guide (the finish time = total work-hours ÷ cleaners),
 * matching how the original slot was reserved at generation.
 */
export async function reserveHoursForQuote(
  quote: Quote,
  inquiry: Inquiry
): Promise<number> {
  const s = normalizeHHMM(quote.proposed_start_time ?? "");
  const e = normalizeHHMM(quote.proposed_end_time ?? "");
  if (s && e) {
    const [sh, sm] = s.split(":").map(Number);
    const [eh, em] = e.split(":").map(Number);
    const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
    if (hours > 0) return hours;
  }
  const { estimate } = await computeEstimateForInquiry(inquiry);
  return estimate.finishHoursMax ?? estimate.hoursMax ?? 2;
}
