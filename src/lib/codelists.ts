import type { TransactionFlagsInput } from "./invoice-types.js";

export * from "./codelists-data.js";

export const PINT_AE_CUSTOMIZATION_ID = "urn:peppol:pint:billing-1@ae-1";
export const PINT_AE_SELFBILLING_CUSTOMIZATION_ID = "urn:peppol:pint:selfbilling-1@ae-1";
export const PINT_AE_PROFILE_ID = "urn:peppol:bis:billing";
export const PINT_AE_SELFBILLING_PROFILE_ID = "urn:peppol:bis:selfbilling";
export const UAE_ENDPOINT_SCHEME = "0235";

/** ibr-128-ae: allowed country subdivisions when the country code is AE. */
export const EMIRATE_CODES: Readonly<Record<string, string>> = {
  AUH: "Abu Dhabi",
  DXB: "Dubai",
  SHJ: "Sharjah",
  UAQ: "Umm Al Quwain",
  FUJ: "Fujairah",
  AJM: "Ajman",
  RAK: "Ras Al Khaimah",
};

/** BTAE-16 / BTAE-15 legal registration identifier types (ibr-173-ae, ibr-183-ae). */
export const LEGAL_REGISTRATION_TYPES: Readonly<Record<string, string>> = {
  TL: "Commercial/Trade license",
  EID: "Emirates ID",
  PAS: "Passport",
  CD: "Cabinet decision",
};

const EMIRATE_ALIASES: Record<string, string> = {
  "abu dhabi": "AUH",
  "al ain": "AUH",
  dubai: "DXB",
  sharjah: "SHJ",
  "umm al quwain": "UAQ",
  "umm al-quwain": "UAQ",
  fujairah: "FUJ",
  ajman: "AJM",
  "ras al khaimah": "RAK",
  "ras al-khaimah": "RAK",
};

export function emirateFromCity(city: string | undefined): string | null {
  if (!city) return null;
  const key = city.trim().toLowerCase();
  if (EMIRATE_CODES[key.toUpperCase()]) return key.toUpperCase();
  return EMIRATE_ALIASES[key] ?? null;
}

export const TRANSACTION_FLAG_ORDER: ReadonlyArray<keyof TransactionFlagsInput> = [
  "freeTradeZone",
  "deemedSupply",
  "marginScheme",
  "summaryInvoice",
  "continuousSupply",
  "disclosedAgentBilling",
  "ecommerce",
  "exports",
];

export function transactionTypeFromFlags(flags: TransactionFlagsInput): string {
  return TRANSACTION_FLAG_ORDER.map((k) => (flags[k] ? "1" : "0")).join("");
}

export function flagsFromTransactionType(code: string): Required<TransactionFlagsInput> {
  const out = {} as Required<TransactionFlagsInput>;
  TRANSACTION_FLAG_ORDER.forEach((k, i) => {
    out[k] = code[i] === "1";
  });
  return out;
}
