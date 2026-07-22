import { resolvePricing } from "./pricing";
import { computeEstimate } from "./extraction";
import { normalizeHHMM } from "./timezone";
import { getSupabaseAdmin } from "./supabase";
import type { Inquiry, PricingTier, Quote, TimeEstimate } from "./types";

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
    2
  );
  return estimate.finishHoursMax ?? estimate.hoursMax ?? 2;
}
