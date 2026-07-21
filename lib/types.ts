// Shared row shapes for the tables we read/write.

export type Inquiry = {
  id: string;
  service_type: string;
  property_size: string;
  postal_code: string;
  city: string | null;
  frequency: string;
  name: string;
  email: string;
  phone: string;
  notes: string | null;
  status: string;
  created_at: string;
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
