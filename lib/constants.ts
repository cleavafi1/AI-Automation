// Shared enums and Finnish labels for the inquiry form.
// Kept in one place so the client form, server validation and DB stay in sync.

export const SERVICE_TYPES = [
  { value: "kotisiivous", label: "Kotisiivous" },
  { value: "muuttosiivous", label: "Muuttosiivous" },
  { value: "toimistosiivous", label: "Toimistosiivous" },
  { value: "ikkunanpesu", label: "Ikkunanpesu" },
  { value: "suursiivous", label: "Suursiivous" },
  { value: "erikoissiivous", label: "Erikoissiivous" },
  { value: "porrassiivous", label: "Porrassiivous" },
] as const;

export const PROPERTY_SIZES = [
  { value: "alle_35", label: "alle 35 m²" },
  { value: "35_49", label: "35–49 m²" },
  { value: "50_64", label: "50–64 m²" },
  { value: "65_79", label: "65–79 m²" },
  { value: "80_99", label: "80–99 m²" },
  { value: "100_119", label: "100–119 m²" },
  { value: "120_149", label: "120–149 m²" },
  { value: "150_199", label: "150–199 m²" },
  { value: "200_plus", label: "200+ m²" },
] as const;

export const FREQUENCIES = [
  { value: "kertaluontoinen", label: "Kertaluontoinen" },
  { value: "viikoittain", label: "Viikoittain" },
  { value: "joka_toinen_viikko", label: "Joka toinen viikko" },
  { value: "kuukausittain", label: "Kuukausittain" },
] as const;

export const SERVICE_TYPE_VALUES = SERVICE_TYPES.map((o) => o.value);
export const PROPERTY_SIZE_VALUES = PROPERTY_SIZES.map((o) => o.value);
export const FREQUENCY_VALUES = FREQUENCIES.map((o) => o.value);

// Upper bound (inclusive, m²) of each size bucket, in order. Used to derive the
// legacy bucket string from an AI-extracted numeric m² for display continuity.
// The pricing/hours math itself keys on the raw m² (via time_estimates), not
// on these buckets.
const SIZE_BUCKET_UPPER_BOUNDS: ReadonlyArray<{ value: string; maxM2: number }> = [
  { value: "alle_35", maxM2: 34 },
  { value: "35_49", maxM2: 49 },
  { value: "50_64", maxM2: 64 },
  { value: "65_79", maxM2: 79 },
  { value: "80_99", maxM2: 99 },
  { value: "100_119", maxM2: 119 },
  { value: "120_149", maxM2: 149 },
  { value: "150_199", maxM2: 199 },
  { value: "200_plus", maxM2: Infinity },
];

/** Map an extracted numeric m² to the legacy size-bucket value (for display). */
export function sizeBucketForM2(m2: number | null | undefined): string | null {
  if (m2 == null || !Number.isFinite(m2) || m2 <= 0) return null;
  return (
    SIZE_BUCKET_UPPER_BOUNDS.find((b) => m2 <= b.maxM2)?.value ?? "200_plus"
  );
}

// Home-related services: kotitalousvähennys (household tax deduction) applies
// only to these. Office/commercial services are excluded.
export const HOME_SERVICES = [
  "kotisiivous",
  "muuttosiivous",
  "suursiivous",
  "ikkunanpesu",
] as const;

// Services that are always quote-only (no fixed hourly rate) — these are
// auto-flagged for human review.
export const QUOTE_ONLY_SERVICES = [
  "toimistosiivous",
  "porrassiivous",
  "erikoissiivous",
] as const;

export function isHomeService(serviceType: string): boolean {
  return (HOME_SERVICES as readonly string[]).includes(serviceType);
}

export function isQuoteOnlyService(serviceType: string): boolean {
  return (QUOTE_ONLY_SERVICES as readonly string[]).includes(serviceType);
}

// Human-readable Finnish labels for logging / prompts. Tolerant of the now-
// nullable extracted fields: null/unknown renders as an em dash.
export function serviceLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return SERVICE_TYPES.find((o) => o.value === value)?.label ?? value;
}

export function sizeLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return PROPERTY_SIZES.find((o) => o.value === value)?.label ?? value;
}

export function frequencyLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return FREQUENCIES.find((o) => o.value === value)?.label ?? value;
}

export type ServiceType = (typeof SERVICE_TYPE_VALUES)[number];
export type PropertySize = (typeof PROPERTY_SIZE_VALUES)[number];
export type Frequency = (typeof FREQUENCY_VALUES)[number];
