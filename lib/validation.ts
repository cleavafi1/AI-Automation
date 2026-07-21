import { z } from "zod";

// Phase 4 free-text intake. The customer supplies only their contact details
// and a free-text description of what they want; service type, size, location
// and frequency are extracted from raw_request by Claude afterwards (see
// lib/extraction.ts), never collected via dropdowns.
export const inquirySchema = z.object({
  name: z.string().trim().min(1, "Anna nimesi."),
  email: z.string().trim().email("Anna kelvollinen sähköpostiosoite."),
  phone: z.string().trim().min(1, "Anna puhelinnumerosi."),
  raw_request: z
    .string()
    .trim()
    .min(1, "Kerro lyhyesti mitä toivot.")
    .max(2000, "Viesti on liian pitkä."),
});

export type InquiryInput = z.infer<typeof inquirySchema>;
