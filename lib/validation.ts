import { z } from "zod";
import {
  SERVICE_TYPE_VALUES,
  PROPERTY_SIZE_VALUES,
  FREQUENCY_VALUES,
} from "./constants";

// Finnish postal codes are exactly 5 digits.
const postalCodeRegex = /^\d{5}$/;

export const inquirySchema = z.object({
  service_type: z.enum(SERVICE_TYPE_VALUES as [string, ...string[]], {
    errorMap: () => ({ message: "Valitse palvelu." }),
  }),
  property_size: z.enum(PROPERTY_SIZE_VALUES as [string, ...string[]], {
    errorMap: () => ({ message: "Valitse kohteen koko." }),
  }),
  postal_code: z
    .string()
    .trim()
    .regex(postalCodeRegex, "Anna kelvollinen postinumero (5 numeroa)."),
  frequency: z.enum(FREQUENCY_VALUES as [string, ...string[]], {
    errorMap: () => ({ message: "Valitse siivousväli." }),
  }),
  name: z.string().trim().min(1, "Anna nimesi."),
  email: z.string().trim().email("Anna kelvollinen sähköpostiosoite."),
  phone: z.string().trim().min(1, "Anna puhelinnumerosi."),
  notes: z
    .string()
    .trim()
    .max(2000, "Viesti on liian pitkä.")
    .optional()
    .or(z.literal("")),
});

export type InquiryInput = z.infer<typeof inquirySchema>;
