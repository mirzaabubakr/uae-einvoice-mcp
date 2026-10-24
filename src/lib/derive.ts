import {
  PINT_AE_CUSTOMIZATION_ID,
  PINT_AE_PROFILE_ID,
  UAE_ENDPOINT_SCHEME,
  emirateFromCity,
  flagsFromTransactionType,
  transactionTypeFromFlags,
} from "./codelists.js";
import type {
  InvoiceDataInput,
  InvoiceDocumentType,
  InvoiceLineInput,
  PartyInput,
  TransactionFlagsInput,
} from "./invoice-types.js";

/** A value plus whether it was supplied by the caller or derived from other fields. */
export interface Resolved<T> {
  value: T;
  derived: boolean;
  note?: string;
}

export interface ResolvedParty {
  input: PartyInput | undefined;
  endpoint: Resolved<{ scheme: string; id: string }> | null;
  subdivision: Resolved<string> | null;
}

export interface ResolvedLine {
  index: number;
  input: InvoiceLineInput;
  grossPrice: Resolved<number> | null;
  priceBaseQuantity: Resolved<number>;
  vatAmountAed: Resolved<number> | null;
  lineAmountAed: Resolved<number> | null;
}

export interface ResolvedInvoice {
  input: InvoiceDataInput;
  documentType: InvoiceDocumentType;
  isCreditNote: boolean;
  /** Which MoF mandatory field list applies: the 51-field tax list or the 49-field commercial list. */
  fieldList: "tax_invoice" | "commercial_invoice";
  typeCode: Resolved<string>;
  customizationId: Resolved<string>;
  profileId: Resolved<string>;
  transactionType: Resolved<string> | null;
  flags: Required<TransactionFlagsInput>;
  currency: string;
  isAed: boolean;
  seller: ResolvedParty;
  buyer: ResolvedParty;
  lines: ResolvedLine[];
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function digits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function resolveEndpoint(party: PartyInput | undefined): ResolvedParty["endpoint"] {
  if (!party) return null;
  if (party.peppolId?.trim()) {
    const raw = party.peppolId.trim().replace(/^iso6523-actorid-upis::/i, "");
    const m = /^(\d{4}):(.+)$/.exec(raw);
    if (m) return { value: { scheme: m[1], id: m[2] }, derived: false };
    return { value: { scheme: UAE_ENDPOINT_SCHEME, id: raw }, derived: false };
  }
  const tin = digits(party.tin);
  if (tin.length === 10) {
    return {
      value: { scheme: UAE_ENDPOINT_SCHEME, id: tin },
      derived: true,
      note: "0235 + TIN",
    };
  }
  const trn = digits(party.trn);
  if (trn.length === 15) {
    return {
      value: { scheme: UAE_ENDPOINT_SCHEME, id: trn.slice(0, 10) },
      derived: true,
      note: "0235 + first 10 digits of the TRN",
    };
  }
  return null;
}

function resolveSubdivision(party: PartyInput | undefined): Resolved<string> | null {
  if (!party) return null;
  if (party.countrySubdivision?.trim()) {
    return { value: party.countrySubdivision.trim().toUpperCase(), derived: false };
  }
  if ((party.countryCode ?? "AE") === "AE") {
    const code = emirateFromCity(party.cityOrEmirate);
    if (code) return { value: code, derived: true, note: `from city "${party.cityOrEmirate}"` };
  }
  return null;
}

function resolveParty(party: PartyInput | undefined): ResolvedParty {
  return { input: party, endpoint: resolveEndpoint(party), subdivision: resolveSubdivision(party) };
}

function resolveLine(
  line: InvoiceLineInput,
  index: number,
  isAed: boolean,
): ResolvedLine {
  const grossPrice: ResolvedLine["grossPrice"] =
    typeof line.grossPrice === "number"
      ? { value: line.grossPrice, derived: false }
      : typeof line.unitPrice === "number"
        ? { value: line.unitPrice, derived: true, note: "equal to net price (no price discount)" }
        : null;
  const priceBaseQuantity: ResolvedLine["priceBaseQuantity"] =
    typeof line.priceBaseQuantity === "number"
      ? { value: line.priceBaseQuantity, derived: false }
      : { value: 1, derived: true, note: "default 1" };

  const category = line.taxCategoryCode ?? "";
  const isExempt = category === "E";
  // Reverse charge, zero-rated and out-of-scope lines carry a zero VAT line amount; N needs explicit values.
  const vatRate =
    category === "S" ? (line.taxPercent ?? null) : ["Z", "AE", "O"].includes(category) ? 0 : null;

  let vatAmountAed: ResolvedLine["vatAmountAed"] = null;
  if (typeof line.vatAmountAed === "number") {
    vatAmountAed = { value: line.vatAmountAed, derived: false };
  } else if (isAed && typeof line.netAmount === "number" && vatRate !== null) {
    vatAmountAed = {
      value: round2((line.netAmount * vatRate) / 100),
      derived: true,
      note: "net amount × VAT rate",
    };
  }

  let lineAmountAed: ResolvedLine["lineAmountAed"] = null;
  if (typeof line.lineAmountAed === "number") {
    lineAmountAed = { value: line.lineAmountAed, derived: false };
  } else if (isAed && typeof line.netAmount === "number" && (vatAmountAed || isExempt)) {
    lineAmountAed = {
      value: round2(line.netAmount + (vatAmountAed?.value ?? 0)),
      derived: true,
      note: isExempt ? "net amount (exempt line)" : "net amount + VAT line amount",
    };
  }

  return { index, input: line, grossPrice, priceBaseQuantity, vatAmountAed, lineAmountAed };
}

function defaultTypeCode(documentType: InvoiceDocumentType): string {
  if (documentType === "credit_note") return "381";
  if (documentType === "commercial_invoice") return "480";
  return "380";
}

export function resolveInvoice(invoice: InvoiceDataInput): ResolvedInvoice {
  const documentType: InvoiceDocumentType = invoice.documentType ?? "tax_invoice";
  const isCreditNote = documentType === "credit_note";
  const typeCode: Resolved<string> = invoice.typeCode
    ? { value: invoice.typeCode, derived: false }
    : { value: defaultTypeCode(documentType), derived: true, note: `default for ${documentType}` };
  const fieldList =
    typeCode.value === "480" || typeCode.value === "81" ? "commercial_invoice" : "tax_invoice";

  let transactionType: Resolved<string> | null = null;
  if (invoice.transactionType !== undefined) {
    transactionType = { value: invoice.transactionType, derived: false };
  } else if (invoice.transactionFlags) {
    transactionType = {
      value: transactionTypeFromFlags(invoice.transactionFlags),
      derived: true,
      note: "built from transactionFlags",
    };
  }
  const flags = flagsFromTransactionType(
    transactionType && /^[01]{8}$/.test(transactionType.value) ? transactionType.value : "00000000",
  );

  const currency = invoice.currencyCode ?? "AED";
  const isAed = currency === "AED";

  return {
    input: invoice,
    documentType,
    isCreditNote,
    fieldList,
    typeCode,
    customizationId: invoice.customizationId
      ? { value: invoice.customizationId, derived: false }
      : { value: PINT_AE_CUSTOMIZATION_ID, derived: true, note: "PINT AE default" },
    profileId: invoice.profileId
      ? { value: invoice.profileId, derived: false }
      : { value: PINT_AE_PROFILE_ID, derived: true, note: "PINT AE default" },
    transactionType,
    flags,
    currency,
    isAed,
    seller: resolveParty(invoice.seller),
    buyer: resolveParty(invoice.buyer),
    lines: (invoice.lines ?? []).map((l, i) => resolveLine(l, i, isAed)),
  };
}
