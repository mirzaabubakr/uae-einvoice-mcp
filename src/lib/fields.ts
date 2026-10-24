/**
 * UAE e-invoice mandatory fields — Ministry of Finance "UAE Electronic Invoice Mandatory Fields"
 * v1.0 (23 February 2026): 51 fields for a Tax Invoice, 49 for a Commercial Invoice.
 * Business terms, cardinality and XML paths follow PINT AE Billing 1.0.4; conditional requirements
 * cite the PINT AE Schematron rule that enforces them.
 */
import {
  COUNTRY_CODES,
  CREDIT_NOTE_REASON_CODES,
  CREDIT_NOTE_TYPE_CODES,
  CURRENCY_CODES,
  EMIRATE_CODES,
  INVOICE_TYPE_CODES,
  ITEM_TYPE_CODES,
  LEGAL_REGISTRATION_TYPES,
  PAYMENT_MEANS_CODES,
  RCM_GOODS_TYPE_CODES,
  TAX_CATEGORY_CODES,
  TAX_EXEMPTION_REASON_CODES,
  UAE_ENDPOINT_SCHEME,
  UNIT_CODES,
} from "./codelists.js";
import type { Resolved, ResolvedInvoice, ResolvedLine, ResolvedParty } from "./derive.js";
import type { PartyInput, TaxBreakdownInput } from "./invoice-types.js";
import { isTinFormat, isTrnFormat } from "./trn.js";

export type FieldStatus = "present" | "derived" | "missing" | "invalid" | "not_applicable";
export type FieldGroup =
  | "invoice_details"
  | "seller"
  | "buyer"
  | "document_totals"
  | "tax_breakdown"
  | "invoice_line";

export interface FieldEvaluation {
  status: FieldStatus;
  value?: string | number | boolean | null;
  note?: string;
}

export interface FieldDef {
  key: string;
  /** PINT AE business term, e.g. IBT-001 or BTAE-02. */
  term: string;
  name: string;
  group: FieldGroup;
  cardinality: "1..1" | "0..1";
  ublPath: string;
  /** PINT AE rule identifiers that make the field required or constrain its value. */
  rules?: string[];
  evaluate(r: ResolvedInvoice): FieldEvaluation;
}

export interface NumberedFieldDef extends FieldDef {
  /** Field number in the MoF list. */
  no: number;
}

type Value = string | number | boolean | null | undefined;

const present = (value: Value, note?: string): FieldEvaluation => ({
  status: "present",
  value: value ?? null,
  note,
});
const missing = (note?: string): FieldEvaluation => ({ status: "missing", value: null, note });
const invalid = (value: Value, note: string): FieldEvaluation => ({
  status: "invalid",
  value: value ?? null,
  note,
});
const notApplicable = (note?: string): FieldEvaluation => ({
  status: "not_applicable",
  value: null,
  note,
});

function has(v: Value): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.trim().length > 0;
  return v !== undefined && v !== null;
}

function fromResolved<T extends Value>(res: Resolved<T> | null, missingNote?: string): FieldEvaluation {
  if (!res) return missing(missingNote);
  return res.derived
    ? { status: "derived", value: res.value ?? null, note: res.note }
    : present(res.value);
}

function req(v: Value, missingNote?: string): FieldEvaluation {
  return has(v) ? present(v) : missing(missingNote);
}

function inList(
  v: string | undefined,
  list: Readonly<Record<string, string>>,
  label: string,
  missingNote?: string,
): FieldEvaluation {
  if (!has(v)) return missing(missingNote);
  return list[v!.trim()] !== undefined
    ? present(v, list[v!.trim()])
    : invalid(v, `"${v}" is not in the ${label} code list.`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(v: string | undefined, missingNote?: string): FieldEvaluation {
  if (!has(v)) return missing(missingNote);
  return ISO_DATE.test(v!) ? present(v) : invalid(v, "Use ISO format YYYY-MM-DD.");
}

function num(v: number | undefined, missingNote?: string): FieldEvaluation {
  return typeof v === "number" && Number.isFinite(v) ? present(v) : missing(missingNote);
}

const SEVERITY: Record<FieldStatus, number> = {
  invalid: 4,
  missing: 3,
  derived: 2,
  present: 1,
  not_applicable: 0,
};

/** Aggregate a per-item evaluation (lines, tax breakdown rows) into a single field status. */
function aggregate<T>(
  items: T[],
  label: (item: T, i: number) => string,
  evaluate: (item: T, i: number) => FieldEvaluation,
  emptyNote: string,
): FieldEvaluation {
  if (items.length === 0) return missing(emptyNote);
  const results = items.map((item, i) => ({ item, i, res: evaluate(item, i) }));
  const worst = results.reduce((a, b) => (SEVERITY[b.res.status] > SEVERITY[a.res.status] ? b : a));
  if (worst.res.status === "not_applicable") return notApplicable(worst.res.note);
  const notes = results
    .filter((x) => x.res.status !== "present" && x.res.status !== "not_applicable")
    .map((x) => `${label(x.item, x.i)}: ${x.res.note ?? x.res.status}`);
  const value =
    results.length === 1
      ? (results[0].res.value ?? null)
      : `${results.filter((x) => x.res.status === "present" || x.res.status === "derived").length}/${results.length}`;
  return { status: worst.res.status, value, note: notes.length ? notes.join("; ") : undefined };
}

function forLines(
  r: ResolvedInvoice,
  evaluate: (line: ResolvedLine) => FieldEvaluation,
): FieldEvaluation {
  return aggregate(
    r.lines,
    (l) => `line ${l.input.id ?? l.index + 1}`,
    evaluate,
    "No invoice lines supplied.",
  );
}

function forBreakdown(
  r: ResolvedInvoice,
  evaluate: (row: TaxBreakdownInput) => FieldEvaluation,
): FieldEvaluation {
  return aggregate(
    r.input.taxBreakdown ?? [],
    (row, i) => `breakdown ${i + 1} (${row.taxCategoryCode ?? "?"})`,
    evaluate,
    "No tax breakdown (TaxSubtotal) supplied.",
  );
}

function payable(r: ResolvedInvoice): number {
  return r.input.payableAmount ?? 0;
}

function hasCategory(r: ResolvedInvoice, code: string): boolean {
  return r.lines.some((l) => l.input.taxCategoryCode === code);
}

// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------

const invoiceNumber: FieldDef = {
  key: "invoiceNumber",
  term: "IBT-001",
  name: "Invoice number",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:ID",
  evaluate: (r) => req(r.input.invoiceNumber),
};

const issueDate: FieldDef = {
  key: "issueDate",
  term: "IBT-002",
  name: "Invoice date",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:IssueDate",
  evaluate: (r) => isoDate(r.input.issueDate),
};

const typeCode: FieldDef = {
  key: "typeCode",
  term: "IBT-003",
  name: "Invoice type code",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:InvoiceTypeCode | cbc:CreditNoteTypeCode",
  evaluate: (r) => {
    const list = r.isCreditNote ? CREDIT_NOTE_TYPE_CODES : INVOICE_TYPE_CODES;
    if (list[r.typeCode.value] === undefined) {
      return invalid(
        r.typeCode.value,
        `Allowed ${r.isCreditNote ? "credit note" : "invoice"} type codes: ${Object.keys(list).join(", ")}.`,
      );
    }
    return fromResolved(r.typeCode);
  },
};

const currencyCode: FieldDef = {
  key: "currencyCode",
  term: "IBT-005",
  name: "Invoice currency code",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:DocumentCurrencyCode",
  evaluate: (r) => inList(r.input.currencyCode, CURRENCY_CODES, "ISO 4217"),
};

const transactionType: FieldDef = {
  key: "transactionType",
  term: "BTAE-02",
  name: "Invoice transaction type code",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:ProfileExecutionID",
  rules: ["ibr-154-ae"],
  evaluate: (r) => {
    if (!r.transactionType) {
      return missing(
        'Set transactionType (e.g. "00000000") or transactionFlags: FTZ, deemed supply, margin scheme, summary, continuous, disclosed agent, e-commerce, exports.',
      );
    }
    if (!/^[01]{8}$/.test(r.transactionType.value)) {
      return invalid(r.transactionType.value, "Must be exactly 8 characters of 0/1 (ibr-154-ae).");
    }
    return fromResolved(r.transactionType);
  },
};

const dueDate: FieldDef = {
  key: "dueDate",
  term: "IBT-009",
  name: "Payment due date",
  group: "invoice_details",
  cardinality: "0..1",
  ublPath: "cbc:DueDate | cac:PaymentMeans/cbc:PaymentDueDate",
  rules: ["ibr-127-ae"],
  evaluate: (r) => {
    if (has(r.input.dueDate)) return isoDate(r.input.dueDate);
    const required = payable(r) > 0 && !r.isCreditNote && !r.flags.deemedSupply;
    return required
      ? missing("Required when the amount due is greater than 0 (ibr-127-ae).")
      : notApplicable("Not required for credit notes, deemed supplies or zero amount due.");
  },
};

const profileId: FieldDef = {
  key: "profileId",
  term: "IBT-023",
  name: "Business process type",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:ProfileID",
  rules: ["aligned-ibrp-002-ae"],
  evaluate: (r) =>
    /^urn:peppol:bis:(billing|selfbilling)$/.test(r.profileId.value)
      ? fromResolved(r.profileId)
      : invalid(r.profileId.value, "Must be urn:peppol:bis:billing or urn:peppol:bis:selfbilling."),
};

const customizationId: FieldDef = {
  key: "customizationId",
  term: "IBT-024",
  name: "Specification identifier",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cbc:CustomizationID",
  rules: ["aligned-ibrp-001-ae", "ibr-sr-63"],
  evaluate: (r) => {
    const v = r.customizationId.value;
    if (v.includes("*")) return invalid(v, "Wildcard * is not allowed (ibr-sr-63).");
    if (!/^urn:peppol:pint:(billing|selfbilling)-1@ae-1/.test(v)) {
      return invalid(v, "Must start with urn:peppol:pint:billing-1@ae-1 (or selfbilling-1@ae-1).");
    }
    return fromResolved(r.customizationId);
  },
};

const paymentMeansCode: FieldDef = {
  key: "paymentMeansCode",
  term: "IBT-081",
  name: "Payment means type code",
  group: "invoice_details",
  cardinality: "1..1",
  ublPath: "cac:PaymentMeans/cbc:PaymentMeansCode",
  rules: ["ibr-191-ae"],
  evaluate: (r) => {
    if (!has(r.input.paymentMeansCode) && (r.isCreditNote || r.flags.deemedSupply)) {
      return notApplicable("Not required for credit notes or deemed supplies (ibr-191-ae).");
    }
    return inList(r.input.paymentMeansCode, PAYMENT_MEANS_CODES, "UNCL4461 (AE subset)");
  },
};

function partyName(role: "seller" | "buyer", no: string): FieldDef {
  return {
    key: `${role}.legalName`,
    term: no,
    name: role === "seller" ? "Seller name" : "Buyer name",
    group: role,
    cardinality: "1..1",
    ublPath: `cac:${role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty"}/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`,
    evaluate: (r) => req(r.input[role]?.legalName),
  };
}

function endpointId(role: "seller" | "buyer"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  return {
    key: `${role}.endpointId`,
    term: role === "seller" ? "IBT-034" : "IBT-049",
    name: role === "seller" ? "Seller electronic address" : "Buyer electronic address",
    group: role,
    cardinality: "1..1",
    ublPath: `cac:${wrapper}/cac:Party/cbc:EndpointID`,
    evaluate: (r) => {
      const ep = r[role].endpoint;
      if (!ep) return missing("Provide tin (10 digits), trn (15 digits) or peppolId.");
      if (ep.value.scheme === UAE_ENDPOINT_SCHEME && !/^[19]\d{9}$/.test(ep.value.id)) {
        return invalid(ep.value.id, "Under scheme 0235 the address is a 10-digit TIN (1XXXXXXXXX) or a predefined 9XXXXXXXXX endpoint.");
      }
      return ep.derived
        ? { status: "derived", value: ep.value.id, note: ep.note }
        : present(ep.value.id);
    },
  };
}

function endpointScheme(role: "seller" | "buyer"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  return {
    key: `${role}.endpointScheme`,
    term: role === "seller" ? "IBT-034-1" : "IBT-049-1",
    name: role === "seller" ? "Seller electronic identifier" : "Buyer electronic identifier",
    group: role,
    cardinality: "1..1",
    ublPath: `cac:${wrapper}/cac:Party/cbc:EndpointID/@schemeID`,
    evaluate: (r) => {
      const ep = r[role].endpoint;
      if (!ep) return missing("Derived from the electronic address.");
      if (role === "seller" && ep.value.scheme !== UAE_ENDPOINT_SCHEME) {
        return invalid(ep.value.scheme, "UAE sellers use the fixed scheme 0235.");
      }
      return ep.derived
        ? { status: "derived", value: ep.value.scheme, note: "scheme 0235" }
        : present(ep.value.scheme);
    },
  };
}

function legalRegistrationId(role: "seller" | "buyer"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  return {
    key: `${role}.legalRegistrationId`,
    term: role === "seller" ? "IBT-030" : "IBT-047",
    name: role === "seller" ? "Seller legal registration identifier" : "Buyer legal registration identifier",
    group: role,
    cardinality: "0..1",
    ublPath: `cac:${wrapper}/cac:Party/cac:PartyLegalEntity/cbc:CompanyID`,
    rules: role === "seller" ? ["ibr-150-ae"] : ["ibr-136-ae", "ibr-149-ae"],
    evaluate: (r) => {
      const v = r.input[role]?.legalRegistrationId;
      if (has(v)) return present(v);
      const ep = r[role].endpoint?.value;
      if (role === "seller") {
        return ep?.scheme === UAE_ENDPOINT_SCHEME || !ep
          ? missing("Required when the seller uses scheme 0235 (ibr-150-ae), e.g. trade licence number.")
          : notApplicable();
      }
      if (r.fieldList === "commercial_invoice") {
        return missing("Required on out-of-scope invoices and their credit notes (ibr-136-ae).");
      }
      if (ep?.scheme === UAE_ENDPOINT_SCHEME && !/^[19]/.test(ep.id)) {
        return missing("Required when the buyer address under 0235 is not a TIN (ibr-149-ae).");
      }
      return notApplicable("Optional when the buyer is addressed by TIN.");
    },
  };
}

function legalRegistrationType(role: "seller" | "buyer"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  return {
    key: `${role}.legalRegistrationType`,
    term: role === "seller" ? "BTAE-15" : "BTAE-16",
    name: role === "seller" ? "Seller legal registration identifier type" : "Buyer legal registration identifier type",
    group: role,
    cardinality: "0..1",
    ublPath: `cac:${wrapper}/cac:Party/cac:PartyLegalEntity/cbc:CompanyID/@schemeAgencyID`,
    rules: role === "seller" ? ["ibr-181-ae", "ibr-173-ae"] : ["ibr-180-ae", "ibr-183-ae"],
    evaluate: (r) => {
      const party = r.input[role];
      if (!has(party?.legalRegistrationId) && !has(party?.legalRegistrationType)) {
        return notApplicable("Only required with a legal registration identifier.");
      }
      return inList(
        party?.legalRegistrationType,
        LEGAL_REGISTRATION_TYPES,
        "legal registration type (TL, EID, PAS, CD)",
        "Required when a legal registration identifier is given.",
      );
    },
  };
}

function trnField(role: "seller" | "buyer"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  return {
    key: `${role}.trn`,
    term: role === "seller" ? "IBT-031" : "IBT-048",
    name: role === "seller" ? "Seller tax identifier" : "Buyer tax identifier",
    group: role,
    cardinality: "0..1",
    ublPath: `cac:${wrapper}/cac:Party/cac:PartyTaxScheme[cac:TaxScheme/cbc:ID='VAT']/cbc:CompanyID`,
    rules: role === "seller" ? ["ibr-134-ae", "ibr-132-ae"] : ["ibr-103-ae", "ibr-135-ae", "ibr-132-ae"],
    evaluate: (r) => {
      const party = r.input[role];
      const v = party?.trn?.replace(/\D/g, "");
      if (has(v)) {
        if ((party?.countryCode ?? "AE") === "AE" && !isTrnFormat(v!)) {
          return invalid(v, "A UAE TRN is 15 digits, starts with 1 and ends with 03 (ibr-132-ae).");
        }
        return present(v);
      }
      if (role === "seller") {
        return missing("Seller TRN is required on tax invoices and tax credit notes (ibr-134-ae).");
      }
      if (hasCategory(r, "AE")) return missing("Required on reverse-charge lines (ibr-103-ae).");
      const ep = r.buyer.endpoint?.value;
      if (!r.flags.exports && ep?.scheme === UAE_ENDPOINT_SCHEME && !/^1\d{9}$/.test(ep.id)) {
        return missing("Required when the buyer is not addressed by TIN and the sale is not an export (ibr-135-ae).");
      }
      return notApplicable("Provide when the buyer is VAT-registered.");
    },
  };
}

function vatScheme(role: "seller" | "buyer"): FieldDef {
  return {
    key: `${role}.taxScheme`,
    term: role === "seller" ? "IBT-031-1" : "IBT-048-1",
    name: role === "seller" ? "Seller tax scheme code" : "Buyer tax scheme code",
    group: role,
    cardinality: "1..1",
    ublPath: `cac:${role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty"}/cac:Party/cac:PartyTaxScheme/cac:TaxScheme/cbc:ID`,
    evaluate: (r) => {
      if (has(r.input[role]?.trn)) return { status: "derived", value: "VAT", note: "fixed value VAT" };
      return role === "seller" ? missing("Emitted with the seller TRN.") : notApplicable("Emitted with the buyer TRN.");
    },
  };
}

const sellerTaxRegistrationId: FieldDef = {
  key: "seller.taxRegistrationId",
  term: "IBT-032",
  name: "Seller tax registration identifier",
  group: "seller",
  cardinality: "0..1",
  ublPath: "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme[cac:TaxScheme/cbc:ID!='VAT']/cbc:CompanyID",
  rules: ["ibr-177-ae", "ibr-148-ae"],
  evaluate: (r) => {
    const s = r.input.seller;
    const trn = s?.trn?.replace(/\D/g, "");
    const tin = s?.tin?.replace(/\D/g, "");
    if (has(trn)) {
      return isTrnFormat(trn!)
        ? present(trn, "Seller has a TRN; it is emitted as the VAT identifier (IBT-031).")
        : invalid(trn, "A UAE TRN is 15 digits, starts with 1 and ends with 03 (ibr-132-ae).");
    }
    if (has(tin)) {
      return isTinFormat(tin!) ? present(tin) : invalid(tin, "TIN must be 10 digits starting with 1 (ibr-148-ae).");
    }
    return missing("Either the seller TRN or the seller TIN is required (ibr-177-ae).");
  },
};

const sellerTaxSchemeCommercial: FieldDef = {
  key: "seller.taxScheme",
  term: "AUTO-28",
  name: "Seller tax scheme code",
  group: "seller",
  cardinality: "1..1",
  ublPath: "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cac:TaxScheme/cbc:ID",
  evaluate: (r) => {
    if (has(r.input.seller?.trn)) return { status: "derived", value: "VAT", note: "fixed value VAT" };
    if (has(r.input.seller?.tin)) return { status: "derived", value: "TIN", note: "TIN scheme for sellers without a TRN" };
    return missing("Emitted with the seller TRN or TIN.");
  },
};

function address(role: "seller" | "buyer", part: "line" | "city" | "subdivision" | "country"): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  const label = role === "seller" ? "Seller" : "Buyer";
  const base = `cac:${wrapper}/cac:Party/cac:PostalAddress`;
  const terms = {
    seller: { line: "IBT-035", city: "IBT-037", subdivision: "IBT-039", country: "IBT-040" },
    buyer: { line: "IBT-050", city: "IBT-052", subdivision: "IBT-054", country: "IBT-055" },
  }[role];
  const party = (r: ResolvedInvoice): PartyInput | undefined => r.input[role];
  const resolved = (r: ResolvedInvoice): ResolvedParty => r[role];
  const defs = {
    line: {
      name: `${label} address line 1`,
      path: `${base}/cbc:StreetName`,
      rules: [role === "seller" ? "ibr-143-ae" : "ibr-144-ae"],
      evaluate: (r: ResolvedInvoice) => req(party(r)?.addressLine),
    },
    city: {
      name: `${label} city`,
      path: `${base}/cbc:CityName`,
      rules: [role === "seller" ? "ibr-143-ae" : "ibr-144-ae"],
      evaluate: (r: ResolvedInvoice) => req(party(r)?.cityOrEmirate),
    },
    subdivision: {
      name: `${label} country subdivision`,
      path: `${base}/cbc:CountrySubentity`,
      rules: [role === "seller" ? "ibr-143-ae" : "ibr-144-ae", "ibr-128-ae"],
      evaluate: (r: ResolvedInvoice) => {
        const sub = resolved(r).subdivision;
        if (!sub) {
          return missing(
            `Set countrySubdivision (${Object.keys(EMIRATE_CODES).join(", ")} for AE).`,
          );
        }
        if ((party(r)?.countryCode ?? "AE") === "AE" && EMIRATE_CODES[sub.value] === undefined) {
          return invalid(sub.value, `For AE use one of ${Object.keys(EMIRATE_CODES).join(", ")} (ibr-128-ae).`);
        }
        return fromResolved(sub);
      },
    },
    country: {
      name: `${label} country code`,
      path: `${base}/cac:Country/cbc:IdentificationCode`,
      rules: [] as string[],
      evaluate: (r: ResolvedInvoice) => inList(party(r)?.countryCode, COUNTRY_CODES, "ISO 3166-1 alpha-2"),
    },
  }[part];
  return {
    key: `${role}.${part === "line" ? "addressLine" : part === "city" ? "cityOrEmirate" : part === "subdivision" ? "countrySubdivision" : "countryCode"}`,
    term: terms[part],
    name: defs.name,
    group: role,
    cardinality: "1..1",
    ublPath: defs.path,
    rules: defs.rules.length ? defs.rules : undefined,
    evaluate: defs.evaluate,
  };
}

function total(
  key: "lineNetTotal" | "taxExclusiveTotal" | "taxTotal" | "taxInclusiveTotal" | "payableAmount",
  term: string,
  name: string,
  ublPath: string,
): FieldDef {
  return {
    key,
    term,
    name,
    group: "document_totals",
    cardinality: "1..1",
    ublPath,
    evaluate: (r) => num(r.input[key]),
  };
}

const lineNetTotal = total("lineNetTotal", "IBT-106", "Sum of invoice line net amount", "cac:LegalMonetaryTotal/cbc:LineExtensionAmount");
const taxExclusiveTotal = total("taxExclusiveTotal", "IBT-109", "Invoice total amount without tax", "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount");
const taxTotal = total("taxTotal", "IBT-110", "Invoice total tax amount", "cac:TaxTotal/cbc:TaxAmount");
const taxInclusiveTotal = total("taxInclusiveTotal", "IBT-112", "Invoice total amount with tax", "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount");
const payableAmount = total("payableAmount", "IBT-115", "Amount due for payment", "cac:LegalMonetaryTotal/cbc:PayableAmount");

const breakdownTaxable: FieldDef = {
  key: "taxBreakdown.taxableAmount",
  term: "IBT-116",
  name: "Tax category taxable amount",
  group: "tax_breakdown",
  cardinality: "1..1",
  ublPath: "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount",
  evaluate: (r) => forBreakdown(r, (row) => num(row.taxableAmount)),
};

const breakdownTax: FieldDef = {
  key: "taxBreakdown.taxAmount",
  term: "IBT-117",
  name: "Tax category tax amount",
  group: "tax_breakdown",
  cardinality: "1..1",
  ublPath: "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount",
  evaluate: (r) => forBreakdown(r, (row) => num(row.taxAmount)),
};

const breakdownCategory: FieldDef = {
  key: "taxBreakdown.taxCategoryCode",
  term: "IBT-118",
  name: "Tax category code",
  group: "tax_breakdown",
  cardinality: "1..1",
  ublPath: "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
  rules: ["ibr-139-ae"],
  evaluate: (r) =>
    forBreakdown(r, (row) => inList(row.taxCategoryCode, TAX_CATEGORY_CODES, "AE tax category")),
};

function rateRule(category: string | undefined, percent: number | undefined): FieldEvaluation {
  const noRate = category === "E" || category === "O";
  if (typeof percent === "number") {
    if (noRate) return invalid(percent, `A rate must not be given for category ${category}.`);
    if (category === "S" && percent <= 0) return invalid(percent, "Standard-rated VAT rate must be greater than 0.");
    if (category === "Z" && percent !== 0) return invalid(percent, "Zero-rated VAT rate must be 0.");
    return present(percent);
  }
  return noRate ? notApplicable(`No rate for category ${category}.`) : missing("Required unless the category is E or O.");
}

const breakdownRate: FieldDef = {
  key: "taxBreakdown.taxPercent",
  term: "IBT-119",
  name: "Tax category rate",
  group: "tax_breakdown",
  cardinality: "0..1",
  ublPath: "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent",
  rules: ["ibr-119-ae", "ibr-121-ae", "ibr-120-ae", "aligned-ibrp-o-11-ae"],
  evaluate: (r) => forBreakdown(r, (row) => rateRule(row.taxCategoryCode, row.taxPercent)),
};

function lineField(
  key: string,
  term: string,
  name: string,
  ublPath: string,
  evaluate: (l: ResolvedLine, r: ResolvedInvoice) => FieldEvaluation,
  extra: Partial<Pick<FieldDef, "cardinality" | "rules">> = {},
): FieldDef {
  return {
    key: `lines.${key}`,
    term,
    name,
    group: "invoice_line",
    cardinality: extra.cardinality ?? "1..1",
    ublPath: `cac:InvoiceLine/${ublPath}`,
    rules: extra.rules,
    evaluate: (r) => forLines(r, (l) => evaluate(l, r)),
  };
}

const lineId = lineField("id", "IBT-126", "Invoice line identifier", "cbc:ID", (l) => req(l.input.id));
const lineQty = lineField("quantity", "IBT-129", "Invoiced quantity", "cbc:InvoicedQuantity", (l) => num(l.input.quantity));
const lineUnit = lineField("unitCode", "IBT-130", "Unit of measure code", "cbc:InvoicedQuantity/@unitCode", (l) =>
  inList(l.input.unitCode, UNIT_CODES, "UN/ECE Rec 20"),
);
const lineNet = lineField("netAmount", "IBT-131", "Invoice line net amount", "cbc:LineExtensionAmount", (l) => num(l.input.netAmount));
const lineNetPrice = lineField("unitPrice", "IBT-146", "Item net price", "cac:Price/cbc:PriceAmount", (l) => num(l.input.unitPrice));
const lineGrossPrice = lineField(
  "grossPrice",
  "IBT-148",
  "Item gross price",
  "cac:Price/cac:AllowanceCharge/cbc:BaseAmount",
  (l) => fromResolved(l.grossPrice, "Derived from the net price when given."),
  { rules: ["ibr-126-ae", "aligned-ibrp-004"] },
);
const lineBaseQty = lineField(
  "priceBaseQuantity",
  "IBT-149",
  "Item price base quantity",
  "cac:Price/cbc:BaseQuantity",
  (l) => fromResolved(l.priceBaseQuantity),
  { rules: ["ibr-126-ae"] },
);
const lineCategory = lineField(
  "taxCategoryCode",
  "IBT-151",
  "Invoiced item tax category code",
  "cac:Item/cac:ClassifiedTaxCategory/cbc:ID",
  (l) => inList(l.input.taxCategoryCode, TAX_CATEGORY_CODES, "AE tax category"),
  { rules: ["ibr-145-ae", "ibr-139-ae"] },
);
const lineRate = lineField(
  "taxPercent",
  "IBT-152",
  "Invoiced item tax rate",
  "cac:Item/cac:ClassifiedTaxCategory/cbc:Percent",
  (l) => rateRule(l.input.taxCategoryCode, l.input.taxPercent),
  { cardinality: "0..1", rules: ["aligned-ibrp-s-05", "aligned-ibrp-e-05", "aligned-ibrp-o-05", "aligned-ibrp-z-05"] },
);
const lineVatAed = lineField(
  "vatAmountAed",
  "BTAE-08",
  "VAT line amount in AED",
  "cac:ItemPriceExtension/cac:TaxTotal/cbc:TaxAmount",
  (l) =>
    l.input.taxCategoryCode === "E"
      ? notApplicable("Not given on exempt lines (ibr-163-ae).")
      : fromResolved(l.vatAmountAed, "Required; derived automatically only for AED invoices."),
  { rules: ["ibr-104-ae", "ibr-163-ae"] },
);
const lineAmountAed = lineField(
  "lineAmountAed",
  "BTAE-10",
  "Invoice line amount in AED",
  "cac:ItemPriceExtension/cbc:Amount",
  (l) => fromResolved(l.lineAmountAed, "Required; derived automatically only for AED invoices."),
  { rules: ["ibr-104-ae", "ibr-194-ae"] },
);
const lineName = lineField("name", "IBT-153", "Item name", "cac:Item/cbc:Name", (l) => req(l.input.name));
const lineDescription = lineField(
  "description",
  "IBT-154",
  "Item description",
  "cac:Item/cbc:Description",
  (l) => req(l.input.description),
  { rules: ["ibr-125-ae"] },
);

function numbered(defs: FieldDef[]): NumberedFieldDef[] {
  return defs.map((d, i) => ({ ...d, no: i + 1 }));
}

/** MoF Tax Invoice list — 51 fields, in the official order. */
export const TAX_INVOICE_FIELDS: NumberedFieldDef[] = numbered([
  invoiceNumber,
  issueDate,
  typeCode,
  currencyCode,
  transactionType,
  dueDate,
  profileId,
  customizationId,
  paymentMeansCode,
  partyName("seller", "IBT-027"),
  endpointId("seller"),
  endpointScheme("seller"),
  legalRegistrationId("seller"),
  legalRegistrationType("seller"),
  trnField("seller"),
  vatScheme("seller"),
  address("seller", "line"),
  address("seller", "city"),
  address("seller", "subdivision"),
  address("seller", "country"),
  partyName("buyer", "IBT-044"),
  endpointId("buyer"),
  endpointScheme("buyer"),
  trnField("buyer"),
  vatScheme("buyer"),
  address("buyer", "line"),
  address("buyer", "city"),
  address("buyer", "subdivision"),
  address("buyer", "country"),
  lineNetTotal,
  taxExclusiveTotal,
  taxTotal,
  taxInclusiveTotal,
  payableAmount,
  breakdownTaxable,
  breakdownTax,
  breakdownCategory,
  breakdownRate,
  lineId,
  lineQty,
  lineUnit,
  lineNet,
  lineNetPrice,
  lineGrossPrice,
  lineBaseQty,
  lineCategory,
  lineRate,
  lineVatAed,
  lineAmountAed,
  lineName,
  lineDescription,
]);

/** MoF Commercial Invoice list — 49 fields, in the official order. */
export const COMMERCIAL_INVOICE_FIELDS: NumberedFieldDef[] = numbered([
  invoiceNumber,
  issueDate,
  typeCode,
  currencyCode,
  transactionType,
  dueDate,
  profileId,
  customizationId,
  paymentMeansCode,
  partyName("seller", "IBT-027"),
  endpointId("seller"),
  endpointScheme("seller"),
  legalRegistrationId("seller"),
  legalRegistrationType("seller"),
  sellerTaxRegistrationId,
  sellerTaxSchemeCommercial,
  address("seller", "line"),
  address("seller", "city"),
  address("seller", "subdivision"),
  address("seller", "country"),
  partyName("buyer", "IBT-044"),
  endpointId("buyer"),
  endpointScheme("buyer"),
  legalRegistrationId("buyer"),
  legalRegistrationType("buyer"),
  address("buyer", "line"),
  address("buyer", "city"),
  address("buyer", "subdivision"),
  address("buyer", "country"),
  lineNetTotal,
  taxExclusiveTotal,
  taxTotal,
  taxInclusiveTotal,
  payableAmount,
  breakdownTaxable,
  breakdownTax,
  breakdownCategory,
  breakdownRate,
  lineId,
  lineQty,
  lineUnit,
  lineNet,
  lineNetPrice,
  lineGrossPrice,
  lineBaseQty,
  lineCategory,
  lineRate,
  lineName,
  lineDescription,
]);

if (TAX_INVOICE_FIELDS.length !== 51 || COMMERCIAL_INVOICE_FIELDS.length !== 49) {
  throw new Error(
    `MoF field lists out of sync: tax ${TAX_INVOICE_FIELDS.length}/51, commercial ${COMMERCIAL_INVOICE_FIELDS.length}/49`,
  );
}

// ---------------------------------------------------------------------------
// PINT AE fields outside the MoF lists that the Schematron requires in some cases
// ---------------------------------------------------------------------------

function conditional(
  key: string,
  term: string,
  name: string,
  ublPath: string,
  rules: string[],
  evaluate: (r: ResolvedInvoice) => FieldEvaluation,
): FieldDef {
  return { key, term, name, group: "invoice_details", cardinality: "0..1", ublPath, rules, evaluate };
}

function partyConditional(
  role: "seller" | "buyer",
  key: "legalRegistrationAuthority" | "passportIssuingCountry",
): FieldDef {
  const wrapper = role === "seller" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  const authority = key === "legalRegistrationAuthority";
  return {
    key: `${role}.${key}`,
    term: authority ? (role === "seller" ? "BTAE-12" : "BTAE-11") : role === "seller" ? "BTAE-18" : "BTAE-19",
    name: authority ? "Authority name" : "Passport issuing country code",
    group: role,
    cardinality: "0..1",
    ublPath: `cac:${wrapper}/cac:Party/cac:PartyLegalEntity/cbc:CompanyID/@schemeAgencyName`,
    rules: authority
      ? [role === "seller" ? "ibr-172-ae" : "ibr-101-ae"]
      : [role === "seller" ? "ibr-012-ae" : "ibr-010-ae"],
    evaluate: (r) => {
      const party = r.input[role];
      const trigger = authority ? "TL" : "PAS";
      if (party?.legalRegistrationType !== trigger) return notApplicable(`Only for registration type ${trigger}.`);
      return authority
        ? req(party?.legalRegistrationAuthority, "Issuing authority is required for trade licences.")
        : inList(party?.passportIssuingCountry, COUNTRY_CODES, "ISO 3166-1 alpha-2", "Issuing country is required for passports.");
    },
  };
}

export const CONDITIONAL_FIELDS: FieldDef[] = [
  conditional("uuid", "BTAE-07", "Unique identifier number", "cbc:UUID", ["ibr-193-ae"], (r) =>
    has(r.input.uuid)
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.input.uuid!)
        ? present(r.input.uuid)
        : invalid(r.input.uuid, "Expected a UUID such as 4b6000ca-0128-4bdc-99a6-406f2909247f.")
      : { status: "derived", value: null, note: "Always required; generate_pint_ae_xml generates one." },
  ),
  conditional("taxCurrencyCode", "IBT-006", "Tax accounting currency", "cbc:TaxCurrencyCode", ["ibr-140-ae", "ibr-153-ae"], (r) => {
    const v = r.input.taxCurrencyCode;
    if (has(v)) return v === "AED" ? present(v) : invalid(v, "Must be AED when present (ibr-140-ae).");
    return r.isAed ? notApplicable("Invoice is in AED.") : missing("Set to AED when the invoice currency is not AED.");
  }),
  conditional("exchangeRate", "BTAE-04", "Currency exchange rate", "cac:TaxExchangeRate/cbc:CalculationRate", ["ibr-159-ae", "ibr-002-ae"], (r) => {
    const v = r.input.exchangeRate;
    if (typeof v === "number") {
      return /^\d+(\.\d{1,6})?$/.test(String(v)) ? present(v) : invalid(v, "At most 6 decimal places (ibr-002-ae).");
    }
    return r.isAed ? notApplicable("Invoice is in AED.") : missing("Required when the invoice currency is not AED (ibr-159-ae).");
  }),
  conditional("taxTotalAed", "IBT-111", "Invoice total VAT amount in tax accounting currency", "cac:TaxTotal[2]/cbc:TaxAmount[@currencyID='AED']", ["ibr-175-ae"], (r) => {
    if (r.isAed && !has(r.input.taxCurrencyCode)) return notApplicable("Invoice is in AED.");
    return num(r.input.taxTotalAed, "Required with a tax accounting currency.");
  }),
  conditional("totalWithVatAed", "BTAE-20", "Invoice total amount with VAT in AED", "cac:AdditionalDocumentReference[cbc:DocumentTypeCode='aedtotal-incl-vat']/cbc:DocumentDescription", ["ibr-175-ae"], (r) => {
    if (r.isAed) return notApplicable("Invoice is in AED.");
    return num(r.input.totalWithVatAed, "Required when the invoice currency is not AED and the tax currency is AED.");
  }),
  ...(["vatAmountAed", "lineAmountAed"] as const).map((k) => ({
    ...(k === "vatAmountAed" ? lineVatAed : lineAmountAed),
    key: `lines.${k}.commercial`,
    evaluate: (r: ResolvedInvoice) =>
      r.fieldList === "commercial_invoice"
        ? (k === "vatAmountAed" ? lineVatAed : lineAmountAed).evaluate(r)
        : notApplicable("Part of the Tax Invoice field list."),
  })),
  conditional("beneficiaryId", "BTAE-01", "Beneficiary ID", "cac:BuyerCustomerParty/cac:Party/cac:PartyIdentification/cbc:ID", ["ibr-007-ae"], (r) =>
    r.flags.freeTradeZone
      ? req(r.input.beneficiaryId, "Required for free trade zone supplies (ibr-007-ae).")
      : notApplicable("Only for the free trade zone flag."),
  ),
  conditional("principalId", "BTAE-14", "Principal ID", "cac:SellerSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID", ["ibr-137-ae", "ibr-176-ae"], (r) => {
    if (!r.flags.disclosedAgentBilling) return notApplicable("Only for disclosed agent billing.");
    const v = r.input.principalId;
    if (!has(v)) return missing("Required for disclosed agent billing (ibr-137-ae).");
    if (v === r.input.seller?.trn) return invalid(v, "Must differ from the seller VAT identifier (ibr-176-ae).");
    return present(v);
  }),
  conditional("invoicePeriod", "IBT-073/IBT-074", "Invoicing period", "cac:InvoicePeriod", ["ibr-138-ae"], (r) => {
    if (!r.flags.summaryInvoice) return notApplicable("Only for summary invoices.");
    return has(r.input.periodStart) && has(r.input.periodEnd)
      ? present(`${r.input.periodStart}..${r.input.periodEnd}`)
      : missing("periodStart and periodEnd are required for summary invoices (ibr-138-ae).");
  }),
  conditional("deliverTo", "IBT-075/IBT-077/IBT-079", "Deliver to address", "cac:Delivery/cac:DeliveryLocation/cac:Address", ["ibr-142-ae", "ibr-152-ae"], (r) => {
    if (!r.flags.ecommerce && !r.flags.exports) return notApplicable("Only for e-commerce or exports.");
    const d = r.input.deliverTo;
    const ok = has(d?.addressLine) && has(d?.cityOrEmirate) && has(d?.countrySubdivision);
    return ok
      ? present(`${d!.addressLine}, ${d!.cityOrEmirate}`)
      : missing("deliverTo.addressLine, cityOrEmirate and countrySubdivision are required.");
  }),
  conditional("paymentAccountId", "IBT-084", "Payment account identifier", "cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID", ["ibr-192-ae"], (r) =>
    r.input.paymentMeansCode === "30"
      ? req(r.input.paymentAccountId, "Required for credit transfer (ibr-192-ae).")
      : notApplicable("Only for credit transfer (30)."),
  ),
  {
    ...lineField(
      "exemptionReasonCode",
      "IBT-186",
      "VAT exemption reason code",
      "cac:Item/cac:ClassifiedTaxCategory/cbc:TaxExemptionReasonCode",
      (l) =>
        l.input.taxCategoryCode === "E"
          ? inList(l.input.exemptionReasonCode, TAX_EXEMPTION_REASON_CODES, "AE exemption reason", "Required on exempt lines (ibr-167-ae).")
          : notApplicable(),
      { cardinality: "0..1", rules: ["ibr-167-ae"] },
    ),
  },
  lineField(
    "classification",
    "BTAE-13/IBT-158/BTAE-17",
    "Item type and classification",
    "cac:Item/cac:CommodityClassification",
    (l) => {
      const t = l.input.itemType;
      if (!t) return notApplicable("Item type is optional.");
      if (ITEM_TYPE_CODES[t] === undefined) return invalid(t, "Item type must be G, S or B.");
      const needHs = t === "G" || t === "B";
      const needSac = t === "S" || t === "B";
      const gaps = [needHs && !has(l.input.hsCode) ? "hsCode" : "", needSac && !has(l.input.serviceAccountingCode) ? "serviceAccountingCode" : ""].filter(Boolean);
      return gaps.length ? missing(`Item type ${t} requires ${gaps.join(" and ")}.`) : present(t);
    },
    { cardinality: "0..1", rules: ["ibr-184-ae", "ibr-185-ae", "ibr-186-ae"] },
  ),
  lineField(
    "rcmGoodsType",
    "BTAE-09",
    "Type of goods or services (reverse charge)",
    "cac:Item/cac:CommodityClassification/cbc:NatureCode",
    (l) => {
      if (l.input.taxCategoryCode !== "AE") return notApplicable();
      const goods = inList(l.input.rcmGoodsType, RCM_GOODS_TYPE_CODES, "RCM goods type", "rcmGoodsType is required on reverse-charge lines (ibr-166-ae).");
      if (goods.status !== "present") return goods;
      return has(l.input.standardItemId)
        ? goods
        : missing("standardItemId (GTIN, scheme 0160) is required on reverse-charge lines (ibr-174-ae).");
    },
    { cardinality: "0..1", rules: ["ibr-166-ae", "ibr-006-ae", "ibr-174-ae"] },
  ),
  conditional("billingReference", "IBT-025", "Preceding invoice reference", "cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID", ["ibr-055-ae"], (r) => {
    if (!r.isCreditNote) return notApplicable("Only for credit notes.");
    if (r.input.creditNoteReasonCode === "VD") return notApplicable("Optional for volume discounts (VD).");
    return req(r.input.billingReference, "Required on credit notes unless the reason code is VD (ibr-055-ae).");
  }),
  conditional("creditNoteReasonCode", "BTAE-03", "Credit note reason code", "cac:DiscrepancyResponse/cbc:ResponseCode", ["ibr-158-ae", "ibr-001-ae"], (r) => {
    if (!r.isCreditNote) return notApplicable("Only for credit notes.");
    if (r.typeCode.value !== "381" && !has(r.input.creditNoteReasonCode)) return notApplicable("Required for type 381.");
    return inList(r.input.creditNoteReasonCode, CREDIT_NOTE_REASON_CODES, "AE credit note reason", "Required on credit notes (ibr-158-ae).");
  }),
  conditional("taxPointDate", "IBT-007", "VAT point date", "cbc:TaxPointDate", ["ibr-141-ae", "ibr-124-ae"], (r) => {
    const v = r.input.taxPointDate;
    if (!has(v)) return notApplicable("Optional.");
    if (r.isCreditNote) return invalid(v, "Not allowed on credit notes (ibr-124-ae).");
    if (!ISO_DATE.test(v!)) return invalid(v, "Use ISO format YYYY-MM-DD.");
    if (r.input.issueDate && v! >= r.input.issueDate) return invalid(v, "Must be before the issue date (ibr-141-ae).");
    return present(v);
  }),
  partyConditional("seller", "legalRegistrationAuthority"),
  partyConditional("seller", "passportIssuingCountry"),
  partyConditional("buyer", "legalRegistrationAuthority"),
  partyConditional("buyer", "passportIssuingCountry"),
];

export function mandatoryFieldsFor(r: ResolvedInvoice): NumberedFieldDef[] {
  return r.fieldList === "commercial_invoice" ? COMMERCIAL_INVOICE_FIELDS : TAX_INVOICE_FIELDS;
}
