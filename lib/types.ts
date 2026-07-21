// Shared row shapes for the tables we read/write.

export type Inquiry = {
  id: string;
  // Free-text intake: the only field the customer actually fills in for the
  // request itself. Everything below is AI-extracted (Phase 4) and nullable.
  raw_request: string | null;
  // AI-extracted, no longer form-guaranteed → all nullable.
  service_type: string | null;
  property_size: string | null;
  // Numeric m² Claude extracted; the time_estimates lookup keys on this.
  property_size_m2: number | null;
  postal_code: string | null;
  city: string | null;
  frequency: string | null;
  // Set when service/size/location couldn't be determined from raw_request.
  needs_clarification: boolean;
  clarification_reason: string | null;
  name: string;
  email: string;
  phone: string;
  notes: string | null;
  status: string;
  created_at: string;
};

// Size-bracket → single-cleaner on-site hour range from the estimation guide.
export type TimeEstimate = {
  id: string;
  service_type: string;
  size_min_m2: number;
  size_max_m2: number;
  hours_min_1c: number;
  hours_max_1c: number;
};

export type PricingTier = {
  id: string;
  service_type: string;
  tier_label: string | null;
  rate_type: "hourly" | "quote_only";
  base_rate_eur: number | null;
  notes: string | null;
};

export type Quote = {
  id: string;
  inquiry_id: string;
  drafted_text: string;
  estimated_price_eur: number | null;
  is_flagged: boolean;
  flag_reason: string | null;
  status: "draft" | "approved" | "rejected";
  created_at: string;
};

export type EmailLog = {
  id: string;
  inquiry_id: string;
  quote_id: string | null;
  direction: "outbound" | "inbound";
  email_type: "offer" | "confirmation" | "reminder";
  to_address: string;
  subject: string;
  body: string;
  resend_message_id: string | null;
  status: "sent" | "failed";
  created_at: string;
};
