import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, QUOTE_MODEL } from "./anthropic";
import { serviceLabel } from "./constants";
import { applyStandardClosing } from "./signature";
import { renderHistoryForPrompt } from "./email-conversations";
import type { EmailConversation, Inquiry, Quote, ReplyIntent } from "./types";
import type { Slot } from "./booking";

// Phase 7 step 5: draft the customer-facing reply for a classified inbound
// message. One Claude call; the intent decides the shape of the reply. The
// standard signature block is appended in code (never written by the model).

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Compact appointment string in the customer's language. */
export function formatAppointment(
  date: string,
  startTime: string,
  endTime: string,
  language: "fi" | "en"
): string {
  const [y, m, d] = date.split("-").map(Number);
  const s = startTime.slice(0, 5);
  const e = endTime.slice(0, 5);
  return language === "en"
    ? `${d} ${MONTHS_EN[m - 1]} ${y}, ${s}–${e}`
    : `${d}.${m}.${y} klo ${s}–${e}`;
}

const DraftSchema = z.object({ drafted_text: z.string() });
const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { drafted_text: { type: "string" } },
  required: ["drafted_text"],
} as const;

const SYSTEM_PROMPT = `Olet Cleavan (Mansio Group Oy) asiakaspalvelun avustaja. Kirjoitat asiakkaalle LYHYEN, kohteliaan sähköpostivastauksen jatkuvassa keskustelussa. Alla kerrotaan LUOKKA (intent) joka määrää vastauksen sisällön.

KIELI: kirjoita vastaus asiakkaan kielellä (annettu KIELI: fi = suomi, en = englanti). Älä sekoita kieliä.

SÄVY: ammattimainen, lämmin, lyhyet lauseet. Sinuttele (suomeksi sinä-muoto). Aloita PELKÄLLÄ "Hei," (fi) / "Hi," (en) — ÄLÄ lisää asiakkaan nimeä.

MUOTOILU: ei luettelomerkkejä eikä ajatusviivoja rivien alussa. Jos esität keston, siivoojat, hinnan tai ajankohdan, käytä nimettyä riviä muodossa "Otsikko: arvo". Jos alla on annettu RAKENTEISET FAKTAT -lohko, sisällytä se SELLAISENAAN (älä muuta lukuja tai muotoa) äläkä toista näitä lukuja erikseen leipätekstissä.

ÄLÄ kirjoita loppuallekirjoitusta tai yhteystietolohkoa — järjestelmä lisää sen automaattisesti.

TÄRKEIMMÄT SÄÄNNÖT (koskevat kaikkia luokkia):
- ÄLÄ KOSKAAN kysy uudelleen tietoa jonka asiakas on jo antanut tai joka on jo tiedossa (osoite, kohteen koko, palvelu, toivottu ajankohta). Kun asiakas antaa pyydetyn tiedon (esim. osoitteen), KUITTAA se lyhyesti ja etene varauksessa — älä kysy "haluatko tilata siivouksen tähän osoitteeseen".
- ÄLÄ pimitä hintaa. Jos kohteen koko (m²) ja hinta ovat tiedossa (annettu alla), ilmoita arviohinta ja arvioitu kesto PROAKTIIVISESTI heti — älä jätä hintaa vasta osoitteen tai muiden yksityiskohtien jälkeen.
- Kun ilmoitat hinnan, ilmoita myös arvioitu KESTO (kuinka kauan siivous kestää paikan päällä) — se on RAKENTEISET FAKTAT -lohkossa.
- LISÄAIKAHUOMAUTUS: jos alla lukee että lisäaikahuomautus koskee tätä kohdetta, mainitse kohteliaasti että arvio voi vaatia 1–2 lisätuntia jos kohde on tavallista likaisempi, ja että ilmoitamme siitä AINA ETUKÄTEEN — ei piilokuluja.

Sisältö luokan mukaan:
- acceptance: vahvista varaus selkeästi. Toista täsmällinen sovittu ajankohta (annetaan alla). Sisällytä RAKENTEISET FAKTAT -lohko (kesto, siivoojat, hinta) jos se on annettu, ja lisäaikahuomautus jos se koskee kohdetta. Kerro lyhyesti että lähetämme laskun sähköpostitse työn jälkeen (maksuehto 7 päivää). Kiitä.
- reschedule_request: jos alla on annettu UUSI EHDOTETTU AIKA, esitä se uutena EHDOTUKSENA (ei varattu) ja pyydä vahvistamaan tai ehdottamaan parempaa. Jos alla lukee ettei vapaata aikaa löytynyt, pahoittele ja pyydä asiakasta ehdottamaan toista päivää. Käytä VAIN annettua aikaa.
- question: vastaa asiakkaan kysymykseen parhaasi mukaan käyttäen VAIN annettuja tietoja (palvelu, koko, hinta, kesto, ajankohta, Cleavan yleiset käytännöt: ALV sisältyy, siivousvälineet sisältyvät, kotitalousvähennys, maksuehto 7 pv, muuttosiivouksen tyytyväisyystakuu). Jos koko ja hinta ovat tiedossa, ilmoita ne (kesto + hinta) samalla ja etene kohti varausta. ÄLÄ keksi yksityiskohtia joita ei ole annettu; jos et tiedä, kerro että selvitämme ja palaamme asiaan.
- decline: kiitä yhteydenotosta kohteliaasti ja totea että olemme käytettävissä myöhemmin. Ei painostusta.
- unclear: jos asiakas antaa tietoa (esim. osoitteen tai koon), kuittaa se ja etene: jos hinta/kesto on tiedossa, ilmoita ne ja ehdota tai vahvista aika; pyydä VAIN aidosti puuttuva tieto. Muuten kirjoita kohtelias paras-yritys-vastaus joka pyytää asiakasta tarkentamaan mitä hän toivoo.

Palauta pelkkä JSON: { "drafted_text": "..." }.`;

export async function draftReplyResponse(params: {
  intent: ReplyIntent;
  quote: Quote;
  inquiry: Inquiry;
  history: EmailConversation[];
  replyText: string;
  language: "fi" | "en";
  // For reschedule_request: the new slot found (or null if none was free).
  newSlot?: Slot | null;
  // Structured duration/cleaners/price facts (same format as the offer), so the
  // reply can restate them proactively. Null when no numeric estimate exists.
  factsBlock?: string | null;
  // Whether the >30 m² "may need +1–2h, announced beforehand" caveat applies.
  mentionExtraHours?: boolean;
}): Promise<string> {
  const {
    intent,
    quote,
    inquiry,
    history,
    replyText,
    language,
    newSlot,
    factsBlock,
    mentionExtraHours,
  } = params;
  const anthropic = getAnthropic();

  const currentAppointment =
    quote.proposed_date && quote.proposed_start_time && quote.proposed_end_time
      ? formatAppointment(
          quote.proposed_date,
          quote.proposed_start_time,
          quote.proposed_end_time,
          language
        )
      : null;

  const rescheduleLine =
    intent === "reschedule_request"
      ? newSlot
        ? `UUSI EHDOTETTU AIKA: ${formatAppointment(newSlot.date, newSlot.startTime, newSlot.endTime, language)}`
        : "UUSI EHDOTETTU AIKA: ei vapaata aikaa löytynyt — pyydä asiakasta ehdottamaan toinen päivä."
      : "";

  const extraHoursLine = mentionExtraHours
    ? "LISÄAIKAHUOMAUTUS: koskee tätä kohdetta (yli 30 m²) — mainitse mahdollisuus 1–2 lisätuntiin ja ETUKÄTEEN ilmoittamisen periaate (ei piilokuluja)."
    : "";
  const factsLines = factsBlock
    ? [
        "",
        "RAKENTEISET FAKTAT (sisällytä vastaukseen SELLAISENAAN nimettyinä riveinä — älä muuta lukuja tai muotoa, äläkä toista näitä lukuja leipätekstissä):",
        factsBlock,
      ]
    : [];

  const userContent = [
    `KIELI: ${language}`,
    `LUOKKA (intent): ${intent}`,
    "",
    "TARJOUKSEN KONTEKSTI:",
    `Asiakas: ${inquiry.name}`,
    `Palvelu: ${serviceLabel(inquiry.service_type)}`,
    `Koko: ${inquiry.property_size_m2 != null ? inquiry.property_size_m2 + " m²" : "—"}`,
    `Arviohinta: ${quote.estimated_price_eur != null ? quote.estimated_price_eur + " € alkaen (sis. ALV)" : "tarjouspohjainen"}`,
    `Nykyinen sovittu/ehdotettu ajankohta: ${currentAppointment ?? "ei ehdotettua aikaa"}`,
    rescheduleLine,
    extraHoursLine,
    ...factsLines,
    "",
    "VIESTIHISTORIA (vanhin ensin):",
    renderHistoryForPrompt(history),
    "",
    "ASIAKKAAN UUSIN VIESTI:",
    replyText,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 2000,
    output_config: {
      format: { type: "json_schema", schema: DRAFT_JSON_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to draft this reply.");
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = DraftSchema.parse(JSON.parse(rawText));
  return applyStandardClosing(parsed.drafted_text);
}

const REVISE_SYSTEM_PROMPT = `Olet Cleavan asiakaspalvelun avustaja. Henkilökunta antaa vapaamuotoisen muutospyynnön asiakkaalle menevään sähköpostivastausluonnokseen. Toteuta VAIN pyydetty muutos ja kirjoita vastaus uudelleen.

- Säilytä sama kieli kuin nykyisessä luonnoksessa (fi/en). Älä sekoita kieliä.
- Säilytä lyhyt, kohtelias sävy ja sinä-muoto. Ei luettelomerkkejä.
- ÄLÄ kirjoita loppuallekirjoitusta tai yhteystietolohkoa — järjestelmä lisää sen automaattisesti. Jos nykyisessä tekstissä on allekirjoitus, jätä se pois.
- Älä keksi uusia faktoja (hinta, aika) joita ei ole annettu.

Palauta pelkkä JSON: { "drafted_text": "..." }.`;

/** Revise a drafted reply from an informal staff instruction (Custom loop). */
export async function reviseReplyDraft(params: {
  currentText: string;
  instruction: string;
}): Promise<string> {
  const anthropic = getAnthropic();
  const userContent = [
    "NYKYINEN VASTAUSLUONNOS:",
    params.currentText,
    "",
    "HENKILÖKUNNAN MUUTOSPYYNTÖ:",
    params.instruction,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: QUOTE_MODEL,
    max_tokens: 2000,
    output_config: {
      format: { type: "json_schema", schema: DRAFT_JSON_SCHEMA },
    },
    system: REVISE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model refused to revise this reply.");
  }
  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = DraftSchema.parse(JSON.parse(rawText));
  return applyStandardClosing(parsed.drafted_text);
}
