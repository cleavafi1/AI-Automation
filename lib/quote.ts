import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "./supabase";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import { resolvePricing, fallbackHoursForSize } from "./pricing";
import {
  extractFromRequest,
  computeEstimate,
  describeEstimate,
  type Estimate,
} from "./extraction";
import { findNearestAvailableSlot, type Slot } from "./booking";
import { parseHelsinkiDateTime } from "./timezone";
import { sendQuoteNotification, isTelegramConfigured } from "./telegram";
import {
  isHomeService,
  serviceLabel,
  sizeLabel,
  frequencyLabel,
  sizeBucketForM2,
} from "./constants";
import type { Inquiry, PricingTier, Quote, TimeEstimate } from "./types";

// Thrown when the requested inquiry doesn't exist — the API route maps this to a 404.
export class InquiryNotFoundError extends Error {
  constructor(id: string) {
    super(`Inquiry not found: ${id}`);
    this.name = "InquiryNotFoundError";
  }
}

const MIN_HOURS = 2;

// What we ask Claude to decide. Price math and hard flag rules are computed in
// code (below) — Claude only handles judgment: classification, drafting, and
// spotting unusual notes.
const QuoteDraftSchema = z.object({
  classification: z.enum(["straightforward", "needs_review"]),
  // Realistic on-site hours for hourly services; null for quote-only or when
  // it can't be estimated.
  estimated_hours: z.number().nullable(),
  notes_flagged: z.boolean(),
  notes_flag_reason: z.string().nullable(),
  // Finnish-language quote/offer text addressed to the customer.
  drafted_text: z.string(),
});

type QuoteDraft = z.infer<typeof QuoteDraftSchema>;

// JSON Schema handed to the Messages API to constrain the response shape.
// Structured outputs require additionalProperties:false and all keys required.
const QUOTE_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: {
      type: "string",
      enum: ["straightforward", "needs_review"],
    },
    estimated_hours: { type: ["number", "null"] },
    notes_flagged: { type: "boolean" },
    notes_flag_reason: { type: ["string", "null"] },
    drafted_text: { type: "string" },
  },
  required: [
    "classification",
    "estimated_hours",
    "notes_flagged",
    "notes_flag_reason",
    "drafted_text",
  ],
} as const;

// Company contact block appended verbatim to the end of every first offer
// (guide §8: Y-tunnus, email, phone, cleava.fi). Language-neutral.
const SIGNATURE_BLOCK = [
  "Cleava Siivouspalvelut",
  "Mansio Group Oy · Y-tunnus 3631044-9",
  "info@cleava.fi · 045 187 8083 · cleava.fi",
].join("\n");

const SYSTEM_PROMPT = `Olet Cleavan (Mansio Group Oy, Y-tunnus 3631044-9) asiakaspalvelun avustaja. Cleava Siivouspalvelut tarjoaa siivouspalveluita pääkaupunkiseudulla (Helsinki, Espoo, Vantaa, Kauniainen; satunnaisesti kauempana esim. Kirkkonummi).

Tehtäväsi on (1) laatia asiakkaalle tarjousluonnos siivouspyynnön pohjalta ja (2) luokitella pyyntö. Tavoite: luonnos on tyyliltään, rakenteeltaan ja hinnoittelultaan kuin ihmisen kirjoittama Cleavan tarjous — ei geneeristä asiakaspalvelutekstiä.

KIELI (ehdoton):
- Kirjoita KOKO asiakkaalle menevä teksti (drafted_text) asiakkaan kielellä. Alla annetaan KIELI: fi = suomi, en = englanti.
- Älä KOSKAAN sekoita kieliä samassa viestissä. Suomi on oletus; jos asiakas kirjoitti englanniksi, vastaa englanniksi.
- (notes_flag_reason on sisäinen kenttä henkilökunnalle — kirjoita se AINA suomeksi kielestä riippumatta.)

SÄVY:
- Ammattimainen mutta lämmin — ei koskaan kylmä eikä liian tuttavallinen.
- Lyhyet, selkeät lauseet. Ei myyntikieltä, ei ylisanoja, ei huutomerkkien viljelyä.
- Sinuttele asiakasta (suomeksi sinä-muoto) ja puhuttele ETUNIMELLÄ.

TARJOUKSEN RAKENNE (8 osaa — sisällytä kaikki tässä järjestyksessä, älä ohita mitään osaa vaikka lyhentäisit sitä):
1. Tervehdys: "Hei [etunimi]," (fi) / "Hi [first name]," (en). VAIN etunimi. ÄLÄ käytä "Hyvä asiakas" tai koko nimeä.
2. Kiitos: heti seuraava rivi. "Kiitos yhteydenotostasi!" (fi) / "Thank you for contacting Cleava Siivouspalvelut." (en).
3. Mitä voimme tehdä: yksi rivi joka vahvistaa että työ onnistuu, sekä ehdotettu aika jos sellainen on annettu alla.
4. Aika-arvio: ilmoita SEKÄ kokonaistyötunnit ETTÄ per-siivooja-tunnit annettujen lukujen mukaan (esim. "6–8 h yhteensä, 3–4 h / siivooja"). Lisää AINA huomautus: lopullinen aika voi olla lyhyempi tai pidempi asunnon kunnosta riippuen — arvio ei ole tae. Käytä VAIN annettuja lukuja, älä keksi tunteja.
5. Hinta: tuntihinta per siivooja (tai kiinteä hinta), ALV sisältyy. Kerro SELVÄSTI, että siivousvälineet ja -aineet sisältyvät hintaan eikä niistä laskuteta erikseen. Käytä vain annettuja euromääriä; älä keksi loppuhintaa. Jos aika-arviossa on nettohinta kotitalousvähennyksen jälkeen, mainitse myös se (35 %, enintään 1 600 € / vuosi / henkilö).
6. Mitä sisältyy (käytä kotisiivoukselle ja muuttosiivoukselle; jätä pois hyvin lyhyissä vastauksissa): lyhyt luettelo palvelun sisällöstä. Kotisiivous esim.: kaappien pintojen puhdistus; lattioiden imurointi ja pesu; kylpyhuoneen perusteellinen siivous ml. kaakelisaumat; pölyjen pyyhintä ja pintojen puhdistus koko asunnossa. Muuttosiivous: koko asunnon perusteellinen loppusiivous vuokranantajan/ostajan luovutuskuntoon.
7. Varauksen vahvistuspyyntö: pyydä asiakasta vastaamaan ja ilmoittamaan: koko nimi, siivousosoite, sekä laskutusosoite jos eri kuin siivousosoite. ÄLÄ keksi muita pakollisia kenttiä. (Ks. alla laskutusosoiteohje.)
8. Maksu + allekirjoitus: kerro että lasku lähetetään sähköpostitse työn valmistuttua (EI koskaan etukäteen), maksuehto 7 päivää. Allekirjoita "Ystävällisin terveisin," (fi) / "Best regards," (en), sitten "Cleava-tiimi". Liitä aivan loppuun alla annettu YHTEYSTIETOLOHKO SELLAISENAAN (älä muokkaa sitä).

LISÄOHJEET:
- EHDOTETTU AIKA: jos alla on ehdotettu aika, esitä se EHDOTUKSENA joka vaatii asiakkaan vahvistuksen ("ehdotettu aika" / "alustava ehdotus"). ÄLÄ KOSKAAN kirjoita että aika on "varattu", "vahvistettu" tai "sovittu". Pyydä vahvistamaan tai ehdottamaan parempaa aikaa. Käytä VAIN annettua aikaa. Jos ehdotettua aikaa EI ole, älä mainitse tarkkaa aikaa; pyydä asiakasta kertomaan sopiva päivä.
- MUUTTOSIIVOUS: mainitse lyhyesti tyytyväisyystakuu — jos vuokranantajan/isännöitsijän muuttotarkastuksessa ilmenee siivoukseen liittyviä puutteita, palaamme kohteeseen ja korjaamme ne veloituksetta.
- LISÄPALVELUT: voit mainita että saatavilla on valinnaisia lisäpalveluita (esim. uunin pesu) erillistä lisähintaa vastaan, jos asiakas haluaa — älä lisää niitä hintaan automaattisesti.
- MAKSUTAPA (englanninkieliset/kansainväliset asiakkaat): voit tarjota MobilePayta nopeampana maksuvaihtoehtona (numero 045 187 8083).
- LISÄAIKAHUOMAUTUS (jos annettu alla): kerro kohteliaasti, että arvio voi vaatia 1–2 lisätuntia jos kohde on tavallista likaisempi, ja että ilmoitamme AINA ETUKÄTEEN ennen lisäajan käyttöä — ei piilokuluja.
- LASKUTUSOSOITE: jos alla lukee että laskutusosoite puuttuu tai on vajaa, pyydä täydellinen laskutusosoite (katuosoite, rakennuksen numero, asunnon/oven numero, postinumero). Jos se on jo täydellinen, voit vahvistaa sen lyhyesti äläkä pyydä uudelleen.
- PUUTTUVAT TIEDOT (HUOM-rivi): ÄLÄ esitä hinta-arviota epävarmoista tiedoista. Säilytä tervehdys ja kiitos, kerro että autamme mielellämme, ja pyydä kohteliaasti VAIN puuttuvat tiedot (koko, palvelu tai sijainti), niin lähetämme tarkan tarjouksen ja aikaisimman vapaan ajan. Allekirjoita normaalisti.
- TARJOUSPOHJAINEN palvelu (ei kiinteää tuntihintaa) tai aika-arviota ei voitu laskea: kerro että laadimme räätälöidyn tarjouksen, äläkä keksi hintaa.

KENTÄT:
- classification: "straightforward" jos pyyntö on selkeä ja vakiomuotoinen; "needs_review" jos siihen liittyy harkintaa vaativaa (lemmikit, kulku/avaimet, riidat, erikoistoiveet, epäselvyydet, tai aina tarjouspohjainen palvelu).
- estimated_hours: realistinen työtuntimäärä VAIN jos palvelulla on kiinteä tuntihinta, muuten null. Vähimmäistilaus ${MIN_HOURS} h.
- notes_flagged: true jos lisätiedoissa jotain tavallisesta poikkeavaa; muuten false.
- notes_flag_reason: lyhyt suomenkielinen perustelu jos notes_flagged on true, muuten null.
- drafted_text: valmis tarjousluonnos asiakkaalle yllä olevan rakenteen, sävyn ja KIELEN mukaan.`;

function buildUserContent(
  inquiry: Inquiry,
  pricing: ReturnType<typeof resolvePricing>,
  estimate: Estimate,
  proposedSlot: Slot | null,
  language: "fi" | "en"
): string {
  const homeService = inquiry.service_type
    ? isHomeService(inquiry.service_type)
    : false;
  const rateLine =
    pricing.rateType === "hourly" && pricing.baseRate != null
      ? `Kiinteä tuntihinta: ${pricing.baseRate} €/h${
          pricing.tierNotes ? ` (${pricing.tierNotes})` : ""
        }`
      : "Tuntihintaa ei ole — palvelu on tarjouspohjainen (räätälöity tarjous).";

  const sizeText =
    inquiry.property_size_m2 != null
      ? `${inquiry.property_size_m2} m²`
      : sizeLabel(inquiry.property_size);

  // Extra-hours transparency caveat: only for jobs over 30 m² (client rule).
  // Under 30 m² we don't mention it. The base estimate is unchanged — this is a
  // proactive "might need +1–2h, we'll always tell you first" note.
  const m2 = inquiry.property_size_m2;
  const extraHoursNote =
    m2 != null && m2 > 30
      ? `- LISÄAIKAHUOMAUTUS: kohde on ${m2} m² (yli 30 m²) — mainitse mahdollisuus 1–2 lisätuntiin${
          m2 > 40 ? " (suuremmissa/likaisemmissa kohteissa jopa 2 tuntia)" : ""
        } ja ETUKÄTEEN ilmoittamisen periaate (ei piilokuluja).`
      : "";

  // Billing address for invoicing. We show what we have; if incomplete, the
  // draft must ask the customer to supply the missing parts.
  const billingParts = [
    inquiry.billing_street,
    inquiry.billing_building_number,
    inquiry.billing_apartment,
    inquiry.postal_code,
    inquiry.city,
  ].filter(Boolean);
  const billingKnown = billingParts.length ? billingParts.join(" ") : "(ei tiedossa)";
  const billingLine = inquiry.needs_billing_address
    ? `- LASKUTUSOSOITE PUUTTUU tai on vajaa (tiedossa: ${billingKnown}). Pyydä asiakkaalta täydellinen laskutusosoite: katuosoite, rakennuksen numero, asunnon/oven numero ja postinumero — tarvitsemme sen laskutusta varten.`
    : `- Laskutusosoite: ${billingKnown} (täydellinen).`;

  return [
    `KIELI: ${language} (${language === "en" ? "kirjoita tarjous ENGLANNIKSI" : "kirjoita tarjous suomeksi"})`,
    "",
    "SIIVOUSPYYNTÖ (asiakkaan omin sanoin):",
    inquiry.raw_request ? inquiry.raw_request : "(ei vapaatekstiä)",
    "",
    "POIMITUT TIEDOT (poimittu tekstistä — älä keksi puuttuvia):",
    `- Nimi: ${inquiry.name}`,
    `- Palvelu: ${serviceLabel(inquiry.service_type)}`,
    `- Kohteen koko: ${sizeText}`,
    `- Siivousväli: ${frequencyLabel(inquiry.frequency)}`,
    `- Sijainti: ${inquiry.postal_code ?? inquiry.city ?? "(ei tiedossa)"}`,
    `- Toivottu ajankohta: ${inquiry.notes ? inquiry.notes : "(ei mainittu)"}`,
    inquiry.needs_clarification
      ? `- HUOM: tietoja puuttuu — ${inquiry.clarification_reason ?? ""}`
      : "",
    "",
    "HINNOITTELU- JA AIKA-ARVIO (laskettu koodissa — käytä näitä, älä keksi omia):",
    `- ${rateLine}`,
    `- ${describeEstimate(inquiry.service_type, estimate)}`,
    `- Kotitalousvähennys koskee tätä palvelua: ${
      homeService ? "KYLLÄ" : "EI / ei tiedossa"
    }`,
    homeService ? extraHoursNote : "",
    billingLine,
    pricing.noRateReason ? `- Huom: ${pricing.noRateReason}` : "",
    "",
    "EHDOTETTU AIKA (laskettu kalenterin saatavuudesta — EI vahvistettu varaus):",
    proposedSlot
      ? `- ${describeProposedSlot(proposedSlot)}`
      : "- Ei ehdotettua aikaa (aikaa ei voitu laskea tai kalenteri ei ollut käytettävissä). Älä ehdota tarkkaa aikaa.",
    "",
    "YHTEYSTIETOLOHKO (liitä tarjouksen loppuun allekirjoituksen jälkeen sellaisenaan):",
    SIGNATURE_BLOCK,
  ]
    .filter(Boolean)
    .join("\n");
}

// Finnish weekday names for the proposed-slot description.
const FI_WEEKDAYS = [
  "sunnuntai",
  "maanantai",
  "tiistai",
  "keskiviikko",
  "torstai",
  "perjantai",
  "lauantai",
];

function describeProposedSlot(slot: Slot): string {
  const [y, m, d] = slot.date.split("-").map(Number);
  // Weekday of the Helsinki calendar date (tz-independent via a UTC anchor).
  const weekday = FI_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const dd = String(d).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${weekday} ${dd}.${mm}.${y} klo ${slot.startTime}–${slot.endTime}`;
}

export async function generateQuoteForInquiry(inquiryId: string): Promise<Quote> {
  const supabase = getSupabaseAdmin();

  // 1. Load the inquiry.
  const { data: inquiry, error: inquiryError } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", inquiryId)
    .maybeSingle();

  if (inquiryError) {
    throw new Error(`Failed to load inquiry: ${inquiryError.message}`);
  }
  if (!inquiry) {
    throw new InquiryNotFoundError(inquiryId);
  }
  let typedInquiry = inquiry as Inquiry;

  // Concrete appointment request (Helsinki), captured from extraction for the
  // slot finder below. Null when the customer gave only a vague time.
  let requestedDate: string | null = null;
  let requestedTime: string | null = null;
  // True when requestedDate is a "by/before X" deadline, not a target day.
  let requestedDateIsDeadline = false;
  // Reply language, detected from the customer's message (guide §5). Default fi.
  let draftLanguage: "fi" | "en" = "fi";

  // 1b. Extract structured fields from the free-text request (Phase 4). This is
  // a separate Claude call from the drafting one below. Persist the extracted
  // fields back onto the inquiry so /admin and the draft prompt both see them.
  if (typedInquiry.raw_request && typedInquiry.raw_request.trim()) {
    const extraction = await extractFromRequest(typedInquiry.raw_request);
    requestedDate = extraction.requested_date;
    requestedTime = extraction.requested_time;
    requestedDateIsDeadline = extraction.date_is_deadline;
    draftLanguage = extraction.language;

    // Fold preferred time + condition notes into the free-text notes column so
    // downstream flag logic / display can use them.
    const notesParts = [
      extraction.preferred_time
        ? `Toivottu ajankohta: ${extraction.preferred_time}`
        : null,
      extraction.condition_notes,
    ].filter(Boolean);
    const mergedNotes = notesParts.length > 0 ? notesParts.join(" | ") : null;

    const extractedFields = {
      service_type: extraction.service_type,
      property_size_m2: extraction.property_size_m2,
      property_size: sizeBucketForM2(extraction.property_size_m2),
      postal_code: extraction.postal_code,
      city: extraction.city,
      frequency: extraction.frequency,
      needs_clarification: extraction.needs_clarification,
      clarification_reason: extraction.clarification_reason,
      billing_street: extraction.billing_street,
      billing_building_number: extraction.billing_building_number,
      billing_apartment: extraction.billing_apartment,
      needs_billing_address: extraction.needs_billing_address,
      notes: mergedNotes,
    };

    const { error: updateError } = await supabase
      .from("inquiries")
      .update(extractedFields)
      .eq("id", typedInquiry.id);
    if (updateError) {
      throw new Error(
        `Failed to save extracted fields: ${updateError.message}`
      );
    }
    typedInquiry = { ...typedInquiry, ...extractedFields };
  }

  // 2. Load pricing tiers for this service and resolve the applicable rate.
  const { data: tiers, error: tiersError } = await supabase
    .from("pricing_tiers")
    .select("*")
    .eq("service_type", typedInquiry.service_type ?? "");

  if (tiersError) {
    throw new Error(`Failed to load pricing tiers: ${tiersError.message}`);
  }
  const pricing = resolvePricing(typedInquiry, (tiers ?? []) as PricingTier[]);

  // 2b. Deterministic hour + price estimate from the time_estimates guide.
  const { data: estimateRows, error: estimatesError } = await supabase
    .from("time_estimates")
    .select("*")
    .eq("service_type", typedInquiry.service_type ?? "");
  if (estimatesError) {
    throw new Error(
      `Failed to load time estimates: ${estimatesError.message}`
    );
  }
  const estimate = computeEstimate(
    typedInquiry.service_type,
    typedInquiry.property_size_m2,
    pricing,
    (estimateRows ?? []) as TimeEstimate[],
    MIN_HOURS
  );

  // 2c. Propose an appointment slot from live calendar availability + booking
  // rules (Phase 5). We reserve the WALL-CLOCK on-site duration — total
  // work-hours ÷ cleaners (upper bound) — not the full 1-cleaner work-hours, so
  // multi-cleaner jobs (e.g. 100–150 m² = 13–16h for one cleaner) actually fit
  // the 08:00–18:00 window. Falls back to hoursMax when no cleaner split
  // applies. Calendar failures must NOT break quote generation.
  let proposedSlot: Slot | null = null;
  const reserveHours = estimate.finishHoursMax ?? estimate.hoursMax;
  if (reserveHours != null) {
    const requested =
      requestedDate != null
        ? parseHelsinkiDateTime(requestedDate, requestedTime ?? "08:00")
        : null;
    try {
      proposedSlot = await findNearestAvailableSlot({
        durationHours: reserveHours,
        requested,
        deadline: requestedDateIsDeadline,
      });
    } catch (err) {
      console.error(
        `[quote] calendar availability lookup failed for inquiry ${typedInquiry.id}:`,
        err
      );
      proposedSlot = null;
    }
  }

  // 3. Ask Claude to classify + draft.
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    // Headroom for adaptive thinking + the full 8-part offer (both languages,
    // what's-included list, signature block). 3000 truncated the JSON.
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: QUOTE_DRAFT_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserContent(
          typedInquiry,
          pricing,
          estimate,
          proposedSlot,
          draftLanguage
        ),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to generate a quote for this inquiry.");
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let draft: QuoteDraft;
  try {
    draft = QuoteDraftSchema.parse(JSON.parse(rawText));
  } catch (err) {
    throw new Error(
      `Model did not return a valid quote draft (stop_reason: ${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // 4. Compute price deterministically (never trust the model for arithmetic).
  // Preferred source: the time_estimates bracket (priceMin = "alkaen" price).
  // Fallback for fixed-rate services with no matching bracket (e.g. suursiivous,
  // or a size outside the guide): the model's hour estimate, else a size-bucket
  // default. The quote may still be flagged, but the reviewer sees a number.
  let estimatedPrice: number | null = null;
  if (estimate.priceMin != null) {
    estimatedPrice = estimate.priceMin;
  } else if (pricing.hasStandardRate && pricing.baseRate != null) {
    const rawHours =
      draft.estimated_hours != null && draft.estimated_hours > 0
        ? draft.estimated_hours
        : fallbackHoursForSize(typedInquiry.property_size);
    const hours = Math.max(rawHours, MIN_HOURS);
    estimatedPrice = Math.round(pricing.baseRate * hours);
  }

  // 5. Aggregate flags — hard rules in code, judgment from the model.
  const reasons: string[] = [];
  if (typedInquiry.needs_clarification) {
    reasons.push(
      typedInquiry.clarification_reason ??
        "Pyynnöstä puuttuu tietoja — vaatii tarkennuksen."
    );
  }
  if (pricing.rateType === "quote_only") {
    reasons.push("Aina tarjouspohjainen palvelu (ei kiinteää tuntihintaa).");
  }
  if (pricing.noRateReason) {
    reasons.push(pricing.noRateReason);
  }
  if (draft.notes_flagged) {
    reasons.push(
      draft.notes_flag_reason ?? "Lisätiedoissa jotain tavallisesta poikkeavaa."
    );
  }
  if (draft.classification === "needs_review") {
    reasons.push("AI-luokitus: vaatii ihmisen tarkistuksen.");
  }
  // Dedupe while preserving order.
  const uniqueReasons = Array.from(new Set(reasons));
  const isFlagged = uniqueReasons.length > 0;
  const flagReason = isFlagged ? uniqueReasons.join(" ") : null;

  // 6. Persist the draft.
  const { data: inserted, error: insertError } = await supabase
    .from("quotes")
    .insert({
      inquiry_id: typedInquiry.id,
      drafted_text: draft.drafted_text,
      estimated_price_eur: estimatedPrice,
      is_flagged: isFlagged,
      flag_reason: flagReason,
      proposed_date: proposedSlot?.date ?? null,
      proposed_start_time: proposedSlot?.startTime ?? null,
      proposed_end_time: proposedSlot?.endTime ?? null,
      // status defaults to 'draft'; calendar_event_id set on approval
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`Failed to save quote: ${insertError.message}`);
  }

  const savedQuote = inserted as Quote;

  // 7. Notify staff on Telegram (Phase 6) with the three action buttons. Like
  // the calendar step, a Telegram outage must NOT break quote generation — we
  // log and move on, and store the message id so the webhook can reference it.
  if (isTelegramConfigured()) {
    try {
      const messageId = await sendQuoteNotification(savedQuote, typedInquiry);
      const { error: tgUpdateError } = await supabase
        .from("quotes")
        .update({ telegram_message_id: messageId })
        .eq("id", savedQuote.id);
      if (tgUpdateError) {
        console.error(
          "[quote] failed to store telegram_message_id:",
          tgUpdateError.message
        );
      } else {
        savedQuote.telegram_message_id = messageId;
      }
    } catch (err) {
      console.error(
        `[quote] Telegram notification failed for quote ${savedQuote.id}:`,
        err
      );
    }
  }

  return savedQuote;
}
