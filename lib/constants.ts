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

export type ServiceType = (typeof SERVICE_TYPE_VALUES)[number];
export type PropertySize = (typeof PROPERTY_SIZE_VALUES)[number];
export type Frequency = (typeof FREQUENCY_VALUES)[number];
