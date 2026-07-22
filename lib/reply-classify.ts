import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import { serviceLabel } from "./constants";
import { helsinkiTodayString } from "./timezone";
import { renderHistoryForPrompt } from "./email-conversations";
import type { EmailConversation, Inquiry, Quote, ReplyIntent } from "./types";

// Phase 7 step 4: classify an inbound customer reply against the full
// conversation history for its quote. Judgment only — no side effects.

const IntentEnum = [
  "acceptance",
  "reschedule_request",
  "question",
  "decline",
  "unclear",
] as const;

const ClassificationSchema = z.object({
  intent: z.enum(IntentEnum),
  // For reschedule_request: the concrete new day/time the customer asked for, if
  // stated. Same strict formats as extraction; null when not given.
  requested_date: z.string().nullable(),
  requested_time: z.string().nullable(),
  // Whether requested_date is a "by/before X" deadline (drives backward search).
  date_is_deadline: z.boolean().nullable(),
  // Language of the customer's reply ("fi" | "en") — the draft must match it.
  language: z.string().nullable(),
  // Short staff-facing rationale (Finnish), shown in the Telegram review message.
  reasoning: z.string(),
});

export type ReplyClassification = {
  intent: ReplyIntent;
  requested_date: string | null;
  requested_time: string | null;
  date_is_deadline: boolean;
  language: "fi" | "en";
  reasoning: string;
};

const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: IntentEnum as unknown as string[] },
    requested_date: { type: ["string", "null"] },
    requested_time: { type: ["string", "null"] },
    date_is_deadline: { type: ["boolean", "null"] },
    language: { type: ["string", "null"] },
    reasoning: { type: "string" },
  },
  required: [
    "intent",
    "requested_date",
    "requested_time",
    "date_is_deadline",
    "language",
    "reasoning",
  ],
} as const;

const SYSTEM_PROMPT = `Olet Cleavan (siivouspalvelu) asiakaspalvelun avustaja. Saat asiakkaan sähköpostivastauksen aiempaan tarjoukseen sekä koko siihenastisen viestihistorian. Tehtäväsi on LUOKITELLA asiakkaan uusin viesti täsmälleen yhteen luokkaan. Älä tee muuta.

Luokat (intent):
- acceptance: asiakas hyväksyy nykyisen ehdotetun ajankohdan / vahvistaa varauksen.
- reschedule_request: asiakas haluaa eri päivän tai kellonajan. Poimi pyydetty uusi päivä/aika jos se on kerrottu.
- question: asiakas kysyy jotain eikä pyydä aikataulumuutosta.
- decline: asiakas ei halua edetä / peruu.
- unclear: viesti ei sovi luottavaisesti mihinkään yllä olevista.

Säännöt:
- Käytä koko viestihistoriaa kontekstina, mutta luokittele VAIN asiakkaan uusin viesti.
- requested_date: TÄSMÄLLINEN päivä muodossa YYYY-MM-DD vain jos asiakas antaa selkeän tai laskettavissa olevan päivän (laske suhteelliset päivät annetusta tämän päivän päivämäärästä). Jos useita vaihtoehtoja, valitse aikaisin. Määräpäivä ("ennen 30.7." / "mennessä") → viimeisin hyväksyttävä päivä ja date_is_deadline=true. Muuten null ja date_is_deadline=false/null.
- requested_time: TÄSMÄLLINEN kellonaika HH:MM (24h) vain jos kerrottu. Muuten null.
- language: "fi" jos asiakkaan uusin viesti on suomeksi, "en" jos englanniksi, muuten "fi".
- reasoning: lyhyt suomenkielinen perustelu henkilökunnalle (1 lause).

Palauta pelkkä JSON annetun skeeman mukaisesti.`;

function contextBlock(quote: Quote, inquiry: Inquiry): string {
  const proposed =
    quote.proposed_date != null
      ? `${quote.proposed_date} klo ${(quote.proposed_start_time ?? "").slice(0, 5)}–${(quote.proposed_end_time ?? "").slice(0, 5)}`
      : "ei ehdotettua aikaa";
  return [
    `Palvelu: ${serviceLabel(inquiry.service_type)}`,
    `Koko: ${inquiry.property_size_m2 != null ? inquiry.property_size_m2 + " m²" : "—"}`,
    `Sijainti: ${[inquiry.postal_code, inquiry.city].filter(Boolean).join(" ") || "—"}`,
    `Nykyinen ehdotettu ajankohta: ${proposed}`,
    `Arviohinta: ${quote.estimated_price_eur != null ? quote.estimated_price_eur + " € alkaen" : "tarjouspohjainen"}`,
  ].join("\n");
}

export async function classifyReply(params: {
  quote: Quote;
  inquiry: Inquiry;
  history: EmailConversation[];
  replyText: string;
}): Promise<ReplyClassification> {
  const { quote, inquiry, history, replyText } = params;
  const anthropic = getAnthropic();

  const userContent = [
    `Tämän päivän päivämäärä (Europe/Helsinki): ${helsinkiTodayString()}.`,
    "",
    "TARJOUKSEN KONTEKSTI:",
    contextBlock(quote, inquiry),
    "",
    "VIESTIHISTORIA (vanhin ensin):",
    renderHistoryForPrompt(history),
    "",
    "ASIAKKAAN UUSIN VIESTI (luokittele tämä):",
    replyText,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 800,
    output_config: {
      format: { type: "json_schema", schema: CLASSIFICATION_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to classify this reply.");
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = ClassificationSchema.parse(JSON.parse(rawText));

  const requested_date =
    parsed.requested_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.requested_date.trim())
      ? parsed.requested_date.trim()
      : null;
  const requested_time =
    parsed.requested_time && /^\d{1,2}:\d{2}$/.test(parsed.requested_time.trim())
      ? parsed.requested_time.trim().padStart(5, "0")
      : null;

  return {
    intent: parsed.intent,
    requested_date,
    requested_time,
    date_is_deadline: requested_date != null && parsed.date_is_deadline === true,
    language: parsed.language === "en" ? "en" : "fi",
    reasoning: parsed.reasoning,
  };
}
