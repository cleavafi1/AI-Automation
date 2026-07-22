import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import { serviceLabel } from "./constants";
import { helsinkiTodayString } from "./timezone";
import type { Inquiry, Quote } from "./types";

// Claude-driven revision of a drafted quote from an informal staff instruction
// (the Telegram "Custom" edit loop). The model rewrites the customer-facing text
// and reports, structurally, whether price or schedule were explicitly changed —
// so code can update those fields deterministically and re-check the calendar.

const RevisionSchema = z.object({
  // The rewritten customer-facing Finnish quote text.
  revised_text: z.string(),
  // Whether the staff explicitly asked to change the price, and the new value.
  price_changed: z.boolean(),
  new_price_eur: z.number().nullable(),
  // Whether the staff explicitly asked to change the appointment date/time.
  schedule_changed: z.boolean(),
  new_date: z.string().nullable(), // YYYY-MM-DD
  new_time: z.string().nullable(), // HH:MM
  // Short staff-facing summary of what changed (for the Telegram reply).
  change_summary: z.string(),
});

export type QuoteRevision = z.infer<typeof RevisionSchema>;

const REVISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    revised_text: { type: "string" },
    price_changed: { type: "boolean" },
    new_price_eur: { type: ["number", "null"] },
    schedule_changed: { type: "boolean" },
    new_date: { type: ["string", "null"] },
    new_time: { type: ["string", "null"] },
    change_summary: { type: "string" },
  },
  required: [
    "revised_text",
    "price_changed",
    "new_price_eur",
    "schedule_changed",
    "new_date",
    "new_time",
    "change_summary",
  ],
} as const;

const SYSTEM_PROMPT = `Olet Cleavan (siivouspalvelu) avustaja. Henkilökunta antaa sinulle vapaamuotoisen muutospyynnön nykyiseen tarjousluonnokseen. Tehtäväsi on toteuttaa PELKÄSTÄÄN pyydetty muutos ja kirjoittaa tarjousteksti uudelleen ammattimaisesti suomeksi.

EHDOTTOMAT SÄÄNNÖT:
- Toteuta vain se muutos, jota henkilökunta nimenomaisesti pyytää.
- Säilytä KAIKKI muut faktat ennallaan (hinta, päivä, kellonaika, kesto, osoite/sijainti, palvelutyyppi, asiakkaan nimi). Älä muuta mitään näistä, ellei sitä nimenomaisesti pyydetä.
- Älä keksi uusia faktoja. Jos pyyntö on epäselvä, tee mahdollisimman pieni järkevä muutos.
- Säilytä Cleavan sävy: kohtelias, asiallinen, ei ylisanoja.
- ÄLÄ kirjoita lopputervehdystä, allekirjoitusta tai yhteystietolohkoa ("Ystävällisin terveisin", "Cleava-tiimi" tms.) — järjestelmä lisää vakioidun allekirjoituksen automaattisesti. Jos nykyisessä tekstissä on allekirjoitus, jätä se pois uudelleenkirjoituksesta.
- Säilytä muotoilu: rakenteiset faktat (kesto, siivoojat, hinta, saatavuus) pysyvät nimettyinä riveinä muodossa "Otsikko: arvo", EI luettelomerkkejä tai viivoja.
- Jos ehdotettu aika on tekstissä, pidä se edelleen EHDOTUKSENA (esim. "ehdotettu aika"), ei vahvistettuna varauksena.

Rakenteiset kentät:
- price_changed: true vain jos hintaa pyydettiin nimenomaisesti muutettavaksi. new_price_eur: uusi euromääräinen hinta numerona (tuntihinnan sijaan lopullinen/arviohinta jos annettu), muuten null.
- schedule_changed: true vain jos päivää tai kellonaikaa pyydettiin nimenomaisesti muutettavaksi. new_date: uusi päivä muodossa YYYY-MM-DD (laske suhteelliset päivät annetusta tämän päivän päivämäärästä), muuten null. new_time: uusi alkamisaika muodossa HH:MM, muuten null.
- change_summary: lyhyt suomenkielinen yhteenveto tehdystä muutoksesta henkilökunnalle.

Palauta pelkkä JSON annetun skeeman mukaisesti.`;

function currentFacts(quote: Quote, inq: Inquiry): string {
  const price =
    quote.estimated_price_eur != null
      ? `${quote.estimated_price_eur} € alkaen`
      : "tarjouspohjainen (ei kiinteää hintaa)";
  const proposed = quote.proposed_date
    ? `${quote.proposed_date} klo ${(quote.proposed_start_time ?? "").slice(
        0,
        5
      )}–${(quote.proposed_end_time ?? "").slice(0, 5)}`
    : "ei ehdotettua aikaa";
  return [
    `- Asiakas: ${inq.name}`,
    `- Palvelu: ${serviceLabel(inq.service_type)}`,
    `- Koko: ${inq.property_size_m2 != null ? inq.property_size_m2 + " m²" : "—"}`,
    `- Sijainti: ${[inq.postal_code, inq.city].filter(Boolean).join(" ") || "—"}`,
    `- Hinta: ${price}`,
    `- Ehdotettu aika: ${proposed}`,
  ].join("\n");
}

/** Revise a drafted quote from an informal staff instruction. */
export async function reviseQuoteDraft(params: {
  quote: Quote;
  inquiry: Inquiry;
  instruction: string;
}): Promise<QuoteRevision> {
  const { quote, inquiry, instruction } = params;
  const anthropic = getAnthropic();

  const userContent = [
    `Tämän päivän päivämäärä (Europe/Helsinki): ${helsinkiTodayString()}.`,
    "",
    "NYKYISET FAKTAT (älä muuta ellei pyydetä):",
    currentFacts(quote, inquiry),
    "",
    "NYKYINEN TARJOUSTEKSTI:",
    quote.drafted_text,
    "",
    "HENKILÖKUNNAN MUUTOSPYYNTÖ:",
    instruction,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 2500,
    output_config: {
      format: { type: "json_schema", schema: REVISION_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to revise this quote.");
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const parsed = RevisionSchema.parse(JSON.parse(rawText));
    // Normalize date/time formats defensively.
    const new_date =
      parsed.new_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.new_date.trim())
        ? parsed.new_date.trim()
        : null;
    const new_time =
      parsed.new_time && /^\d{1,2}:\d{2}$/.test(parsed.new_time.trim())
        ? parsed.new_time.trim().padStart(5, "0")
        : null;
    return { ...parsed, new_date, new_time };
  } catch (err) {
    throw new Error(
      `Model did not return a valid revision (stop_reason: ${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
