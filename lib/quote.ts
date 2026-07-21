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

const SYSTEM_PROMPT = `Olet Cleavan (Mansio Group Oy) asiakaspalvelun avustaja. Cleava tarjoaa siivouspalveluita pääkaupunkiseudulla (Helsinki, Espoo, Vantaa, Kauniainen) ja Jyväskylän alueella.

Tehtäväsi on laatia asiakkaalle suomenkielinen tarjousluonnos siivouspyynnön pohjalta sekä luokitella pyyntö.

Cleavan sävy:
- Kohtelias, asiallinen ja suora.
- Ei hypeä, ei ylisanoja, ei huutomerkkien viljelyä.
- Selkeä ja ammattimainen, kuin hyvä suomalainen palveluyritys.

Ohjeet kenttiin:
- classification: "straightforward" jos pyyntö on selkeä ja vakiomuotoinen; "needs_review" jos siihen liittyy jotain harkintaa vaativaa (esim. lemmikit, kulkuun/avaimiin liittyvät seikat, riitatilanteet, erikoistoiveet, epäselvyydet, tai palvelu on aina tarjouspohjainen).
- estimated_hours: arvioi realistinen työtuntimäärä kohteen koon ja palvelun perusteella VAIN jos palvelulla on kiinteä tuntihinta (kerrotaan alla). Muuten null. Vähimmäistilaus on ${MIN_HOURS} tuntia.
- notes_flagged: true jos asiakkaan lisätiedoissa on jotain tavallisesta poikkeavaa (lemmikit, kulku-/avainasiat, riidat, erikoistoiveet). Muuten false.
- notes_flag_reason: lyhyt suomenkielinen perustelu jos notes_flagged on true, muuten null.
- drafted_text: kohtelias suomenkielinen tarjousluonnos asiakkaalle. Puhuttele asiakasta nimellä.
  - Jos palvelulla on kiinteä tuntihinta: mainitse tuntihinta ja että lopullinen hinta riippuu työhön kuluvasta ajasta. Mainitse ${MIN_HOURS} tunnin vähimmäistilaus jos se koskee palvelua.
  - Jos alla on laskettu AIKA-ARVIO (tuntiarvio ja/tai arviohinta): voit mainita sen suuntaa-antavana arviona. Käytä VAIN annettuja lukuja — älä keksi omia tunteja tai euroja.
  - Jos palvelu on tarjouspohjainen (ei kiinteää tuntihintaa) tai aika-arviota ei voitu laskea: kerro että laadimme kohteesta erillisen, räätälöidyn tarjouksen, äläkä keksi hintaa.
  - Jos pyynnöstä puuttuu olennaisia tietoja (merkitty HUOM-rivillä): pyydä kohteliaasti asiakasta täydentämään puuttuvat tiedot (esim. kohteen koko, palvelu tai sijainti), äläkä esitä hinta-arviota epävarmoista tiedoista.
  - Mainitse kotitalousvähennys (35 %, enintään 1 600 € / vuosi / henkilö) VAIN jos alla kerrotaan että se koskee tätä palvelua.
  - Kerro että otamme yhteyttä 24 tunnin sisällä.
  - Älä keksi euromääräistä loppuhintaa tekstiin — käytä vain annettuja lukuja.
  - Allekirjoita "Ystävällisin terveisin, Cleava-tiimi".`;

function buildUserContent(
  inquiry: Inquiry,
  pricing: ReturnType<typeof resolvePricing>,
  estimate: Estimate
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

  return [
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
    pricing.noRateReason ? `- Huom: ${pricing.noRateReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

  // 1b. Extract structured fields from the free-text request (Phase 4). This is
  // a separate Claude call from the drafting one below. Persist the extracted
  // fields back onto the inquiry so /admin and the draft prompt both see them.
  if (typedInquiry.raw_request && typedInquiry.raw_request.trim()) {
    const extraction = await extractFromRequest(typedInquiry.raw_request);

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

  // 3. Ask Claude to classify + draft.
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: QUOTE_DRAFT_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserContent(typedInquiry, pricing, estimate),
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
      // status defaults to 'draft'
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`Failed to save quote: ${insertError.message}`);
  }

  return inserted as Quote;
}
