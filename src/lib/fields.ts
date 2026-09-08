import type { InvoiceDataInput } from "./invoice-types.js";
import { validateTaxId } from "./trn.js";

export type FieldCategory =
  | "header"
  | "seller"
  | "buyer"
  | "tax"
  | "totals"
  | "lines";

export type FieldRequirement = "always" | "tax_doc" | "conditional";

export type FieldStatus = "present" | "missing" | "invalid" | "not_applicable";

export interface PintFieldDef {
  id: number;
  key: string;
  name: string;
  ublPath: string;
  category: FieldCategory;
  requirement: FieldRequirement;
  /** Human-readable when requirement is conditional */
  conditionNote?: string;
  evaluate: (invoice: InvoiceDataInput) => {
    status: FieldStatus;
    value?: string | number | boolean | null;
    note?: string;
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPECTED_CUSTOMIZATION = "urn:peppol:pint:billing-1@ae-1";
const EXPECTED_PROFILE = "urn:peppol:bis:billing";

function isTaxDoc(invoice: InvoiceDataInput): boolean {
  const t = invoice.documentType ?? "tax_invoice";
  return t === "tax_invoice" || t === "credit_note";
}

function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function hasNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function partyTaxId(party: InvoiceDataInput["seller"]): {
  trn: string | null;
  tin: string | null;
  valid: boolean;
} {
  if (!party) return { trn: null, tin: null, valid: false };
  if (party.trn) {
    const r = validateTaxId(party.trn);
    return {
      trn: r.kind === "trn" ? r.normalized : null,
      tin: r.tin,
      valid: r.valid,
    };
  }
  if (party.tin) {
    const r = validateTaxId(party.tin);
    return { trn: null, tin: r.tin, valid: r.valid };
  }
  return { trn: null, tin: null, valid: false };
}

function firstLine(invoice: InvoiceDataInput) {
  return invoice.lines?.[0];
}

function firstTax(invoice: InvoiceDataInput) {
  return invoice.taxBreakdown?.[0];
}

function parsePeppol(peppolId?: string): { scheme: string; value: string } | null {
  if (!peppolId?.trim()) return null;
  const raw = peppolId.replace(/^iso6523-actorid-upis::/i, "").trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return { scheme: "0235", value: raw };
  return { scheme: raw.slice(0, idx), value: raw.slice(idx + 1) };
}

function sellerEndpoint(invoice: InvoiceDataInput) {
  const parsed = parsePeppol(invoice.seller?.peppolId);
  if (parsed) return parsed;
  const id = partyTaxId(invoice.seller);
  if (id.tin) return { scheme: "0235", value: id.tin };
  return null;
}

function buyerEndpoint(invoice: InvoiceDataInput) {
  const parsed = parsePeppol(invoice.buyer?.peppolId);
  if (parsed) return parsed;
  const id = partyTaxId(invoice.buyer);
  if (id.tin) return { scheme: "0235", value: id.tin };
  return null;
}

/**
 * Working model of the UAE Electronic Invoice Mandatory Fields (51 for tax invoices).
 * Numbering follows commonly published field lists mapped to UBL 2.1 / PINT AE paths.
 * Confirm against the latest MoF mandatory-fields PDF before production go-live.
 */
export const PINT_AE_FIELDS: PintFieldDef[] = [
  {
    id: 1,
    key: "customizationId",
    name: "Customization ID",
    ublPath: "cbc:CustomizationID",
    category: "header",
    requirement: "always",
    evaluate: (inv) => {
      const v = inv.customizationId ?? EXPECTED_CUSTOMIZATION;
      if (!hasText(inv.customizationId)) {
        return { status: "missing", note: `Expected ${EXPECTED_CUSTOMIZATION}` };
      }
      if (inv.customizationId !== EXPECTED_CUSTOMIZATION) {
        return { status: "invalid", value: v, note: `Expected ${EXPECTED_CUSTOMIZATION}` };
      }
      return { status: "present", value: v };
    },
  },
  {
    id: 2,
    key: "profileId",
    name: "Profile ID",
    ublPath: "cbc:ProfileID",
    category: "header",
    requirement: "always",
    evaluate: (inv) => {
      const v = inv.profileId ?? EXPECTED_PROFILE;
      if (!hasText(inv.profileId)) {
        return {
          status: "missing",
          note: `Expected ${EXPECTED_PROFILE} (generator can default this)`,
        };
      }
      return { status: "present", value: v };
    },
  },
  {
    id: 3,
    key: "invoiceNumber",
    name: "Invoice Number",
    ublPath: "cbc:ID",
    category: "header",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.invoiceNumber)
        ? { status: "present", value: inv.invoiceNumber }
        : { status: "missing" },
  },
  {
    id: 4,
    key: "issueDate",
    name: "Invoice Issue Date",
    ublPath: "cbc:IssueDate",
    category: "header",
    requirement: "always",
    evaluate: (inv) => {
      if (!hasText(inv.issueDate)) return { status: "missing" };
      if (!ISO_DATE.test(inv.issueDate!)) {
        return { status: "invalid", value: inv.issueDate, note: "Use YYYY-MM-DD" };
      }
      return { status: "present", value: inv.issueDate };
    },
  },
  {
    id: 5,
    key: "dueDate",
    name: "Invoice Due Date",
    ublPath: "cbc:DueDate",
    category: "header",
    requirement: "conditional",
    conditionNote: "Expected when payment terms / due date apply",
    evaluate: (inv) => {
      if (!hasText(inv.dueDate)) return { status: "missing" };
      if (!ISO_DATE.test(inv.dueDate!)) {
        return { status: "invalid", value: inv.dueDate, note: "Use YYYY-MM-DD" };
      }
      return { status: "present", value: inv.dueDate };
    },
  },
  {
    id: 6,
    key: "typeCode",
    name: "Invoice Type Code",
    ublPath: "cbc:InvoiceTypeCode / cbc:CreditNoteTypeCode",
    category: "header",
    requirement: "always",
    evaluate: (inv) => {
      const doc = inv.documentType ?? "tax_invoice";
      const expected =
        doc === "credit_note" ? "381" : doc === "commercial_invoice" ? "380" : "380";
      if (!hasText(inv.typeCode)) {
        return { status: "missing", note: `Expected ${expected}` };
      }
      return { status: "present", value: inv.typeCode };
    },
  },
  {
    id: 7,
    key: "currencyCode",
    name: "Invoice Currency Code",
    ublPath: "cbc:DocumentCurrencyCode",
    category: "header",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.currencyCode)
        ? { status: "present", value: inv.currencyCode }
        : { status: "missing" },
  },
  {
    id: 8,
    key: "taxCurrencyCode",
    name: "Tax Currency Code",
    ublPath: "cbc:TaxCurrencyCode",
    category: "header",
    requirement: "conditional",
    conditionNote: "Mandatory when DocumentCurrencyCode is not AED (must be AED)",
    evaluate: (inv) => {
      if (!inv.currencyCode || inv.currencyCode === "AED") {
        return {
          status: hasText(inv.taxCurrencyCode) ? "present" : "not_applicable",
          value: inv.taxCurrencyCode ?? null,
        };
      }
      if (!hasText(inv.taxCurrencyCode)) return { status: "missing", note: "Must be AED" };
      if (inv.taxCurrencyCode !== "AED") {
        return { status: "invalid", value: inv.taxCurrencyCode, note: "Must be AED" };
      }
      return { status: "present", value: inv.taxCurrencyCode };
    },
  },
  {
    id: 9,
    key: "buyerReference",
    name: "Buyer Reference",
    ublPath: "cbc:BuyerReference",
    category: "header",
    requirement: "conditional",
    conditionNote: "Mandatory where the buyer has provided a PO / contract reference",
    evaluate: (inv) =>
      hasText(inv.buyerReference)
        ? { status: "present", value: inv.buyerReference }
        : { status: "missing" },
  },
  {
    id: 10,
    key: "periodStart",
    name: "Invoice Period Start Date",
    ublPath: "cac:InvoicePeriod/cbc:StartDate",
    category: "header",
    requirement: "conditional",
    conditionNote: "Mandatory for periodic / continuous supplies",
    evaluate: (inv) =>
      hasText(inv.periodStart)
        ? ISO_DATE.test(inv.periodStart!)
          ? { status: "present", value: inv.periodStart }
          : { status: "invalid", value: inv.periodStart }
        : { status: "missing" },
  },
  {
    id: 11,
    key: "periodEnd",
    name: "Invoice Period End Date",
    ublPath: "cac:InvoicePeriod/cbc:EndDate",
    category: "header",
    requirement: "conditional",
    conditionNote: "Mandatory for periodic / continuous supplies",
    evaluate: (inv) =>
      hasText(inv.periodEnd)
        ? ISO_DATE.test(inv.periodEnd!)
          ? { status: "present", value: inv.periodEnd }
          : { status: "invalid", value: inv.periodEnd }
        : { status: "missing" },
  },
  {
    id: 12,
    key: "taxPointDate",
    name: "Tax Point Date",
    ublPath: "cbc:TaxPointDate",
    category: "header",
    requirement: "conditional",
    conditionNote: "Required when tax point differs from issue date",
    evaluate: (inv) =>
      hasText(inv.taxPointDate)
        ? ISO_DATE.test(inv.taxPointDate!)
          ? { status: "present", value: inv.taxPointDate }
          : { status: "invalid", value: inv.taxPointDate }
        : { status: "missing" },
  },
  {
    id: 13,
    key: "seller.legalName",
    name: "Supplier Legal Name",
    ublPath: "cac:AccountingSupplierParty/.../cbc:RegistrationName",
    category: "seller",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.seller?.legalName)
        ? { status: "present", value: inv.seller!.legalName }
        : { status: "missing" },
  },
  {
    id: 14,
    key: "seller.trn",
    name: "Supplier VAT Registration Number (TRN)",
    ublPath: "cac:AccountingSupplierParty/.../cac:PartyTaxScheme/cbc:CompanyID",
    category: "seller",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const id = partyTaxId(inv.seller);
      if (id.trn && id.valid) return { status: "present", value: id.trn };
      if (id.tin && id.valid) {
        return {
          status: "invalid",
          value: id.tin,
          note: "TIN present, but Field 14 expects the full 15-digit TRN in PartyTaxScheme",
        };
      }
      return { status: "missing" };
    },
  },
  {
    id: 15,
    key: "seller.tradeName",
    name: "Supplier Trade Name",
    ublPath: "cac:AccountingSupplierParty/.../cac:PartyName/cbc:Name",
    category: "seller",
    requirement: "conditional",
    conditionNote: "Required when trading name differs from legal name",
    evaluate: (inv) =>
      hasText(inv.seller?.tradeName)
        ? { status: "present", value: inv.seller!.tradeName }
        : { status: "missing" },
  },
  {
    id: 16,
    key: "seller.addressLine",
    name: "Supplier Address — Street",
    ublPath: "cac:AccountingSupplierParty/.../cbc:StreetName",
    category: "seller",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.seller?.addressLine)
        ? { status: "present", value: inv.seller!.addressLine }
        : { status: "missing" },
  },
  {
    id: 17,
    key: "seller.cityOrEmirate",
    name: "Supplier Address — City",
    ublPath: "cac:AccountingSupplierParty/.../cbc:CityName",
    category: "seller",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.seller?.cityOrEmirate)
        ? { status: "present", value: inv.seller!.cityOrEmirate }
        : { status: "missing" },
  },
  {
    id: 18,
    key: "seller.countryCode",
    name: "Supplier Address — Country",
    ublPath: "cac:AccountingSupplierParty/.../cac:Country/cbc:IdentificationCode",
    category: "seller",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.seller?.countryCode)
        ? { status: "present", value: inv.seller!.countryCode }
        : { status: "missing" },
  },
  {
    id: 19,
    key: "seller.peppolId",
    name: "Supplier Electronic Address",
    ublPath: "cac:AccountingSupplierParty/.../cbc:EndpointID",
    category: "seller",
    requirement: "always",
    evaluate: (inv) => {
      const ep = sellerEndpoint(inv);
      if (!ep) return { status: "missing", note: "Use 0235:<TIN>" };
      return { status: "present", value: `${ep.scheme}:${ep.value}` };
    },
  },
  {
    id: 20,
    key: "seller.peppolScheme",
    name: "Supplier Electronic Address Scheme",
    ublPath: "cbc:EndpointID@schemeID",
    category: "seller",
    requirement: "always",
    evaluate: (inv) => {
      const ep = sellerEndpoint(inv);
      if (!ep) return { status: "missing", note: "Expected schemeID 0235" };
      return { status: "present", value: ep.scheme };
    },
  },
  {
    id: 21,
    key: "seller.contact",
    name: "Supplier Contact Information",
    ublPath: "cac:AccountingSupplierParty/.../cac:Contact",
    category: "seller",
    requirement: "conditional",
    conditionNote: "Name / email / phone where available",
    evaluate: (inv) => {
      const ok =
        hasText(inv.seller?.contactName) ||
        hasText(inv.seller?.email) ||
        hasText(inv.seller?.phone);
      return ok
        ? {
            status: "present",
            value: inv.seller?.email ?? inv.seller?.phone ?? inv.seller?.contactName,
          }
        : { status: "missing" };
    },
  },
  {
    id: 22,
    key: "buyer.legalName",
    name: "Buyer Legal Name",
    ublPath: "cac:AccountingCustomerParty/.../cbc:RegistrationName",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.buyer?.legalName)
        ? { status: "present", value: inv.buyer!.legalName }
        : { status: "missing" },
  },
  {
    id: 23,
    key: "buyer.trn",
    name: "Buyer VAT Registration Number (TRN)",
    ublPath: "cac:AccountingCustomerParty/.../cac:PartyTaxScheme/cbc:CompanyID",
    category: "buyer",
    requirement: "conditional",
    conditionNote: "Mandatory for B2B UAE tax invoices where buyer is VAT-registered",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const id = partyTaxId(inv.buyer);
      if (id.trn && id.valid) return { status: "present", value: id.trn };
      if (id.tin && id.valid) {
        return {
          status: "invalid",
          value: id.tin,
          note: "TIN present; Field 23 expects full 15-digit TRN when buyer is VAT-registered",
        };
      }
      return { status: "missing" };
    },
  },
  {
    id: 24,
    key: "buyer.peppolId",
    name: "Buyer Electronic ID",
    ublPath: "cac:AccountingCustomerParty/.../cbc:EndpointID",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) => {
      const ep = buyerEndpoint(inv);
      if (!ep) return { status: "missing", note: "Use 0235:<TIN>" };
      return { status: "present", value: `${ep.scheme}:${ep.value}` };
    },
  },
  {
    id: 25,
    key: "buyer.peppolScheme",
    name: "Buyer Electronic ID Scheme",
    ublPath: "cbc:EndpointID@schemeID",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) => {
      const ep = buyerEndpoint(inv);
      if (!ep) return { status: "missing", note: "Expected schemeID 0235" };
      return { status: "present", value: ep.scheme };
    },
  },
  {
    id: 26,
    key: "buyer.addressLine",
    name: "Buyer Address — Street",
    ublPath: "cac:AccountingCustomerParty/.../cbc:StreetName",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.buyer?.addressLine)
        ? { status: "present", value: inv.buyer!.addressLine }
        : { status: "missing" },
  },
  {
    id: 27,
    key: "buyer.cityOrEmirate",
    name: "Buyer Address — City",
    ublPath: "cac:AccountingCustomerParty/.../cbc:CityName",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.buyer?.cityOrEmirate)
        ? { status: "present", value: inv.buyer!.cityOrEmirate }
        : { status: "missing" },
  },
  {
    id: 28,
    key: "buyer.countryCode",
    name: "Buyer Address — Country",
    ublPath: "cac:AccountingCustomerParty/.../cac:Country/cbc:IdentificationCode",
    category: "buyer",
    requirement: "always",
    evaluate: (inv) =>
      hasText(inv.buyer?.countryCode)
        ? { status: "present", value: inv.buyer!.countryCode }
        : { status: "missing" },
  },
  {
    id: 29,
    key: "buyer.tradeName",
    name: "Buyer Trade Name",
    ublPath: "cac:AccountingCustomerParty/.../cac:PartyName/cbc:Name",
    category: "buyer",
    requirement: "conditional",
    conditionNote: "Required when trading name differs from legal name",
    evaluate: (inv) =>
      hasText(inv.buyer?.tradeName)
        ? { status: "present", value: inv.buyer!.tradeName }
        : { status: "missing" },
  },
  {
    id: 30,
    key: "buyer.contact",
    name: "Buyer Contact Information",
    ublPath: "cac:AccountingCustomerParty/.../cac:Contact",
    category: "buyer",
    requirement: "conditional",
    conditionNote: "Name / email / phone where available",
    evaluate: (inv) => {
      const ok =
        hasText(inv.buyer?.contactName) ||
        hasText(inv.buyer?.email) ||
        hasText(inv.buyer?.phone);
      return ok
        ? {
            status: "present",
            value: inv.buyer?.email ?? inv.buyer?.phone ?? inv.buyer?.contactName,
          }
        : { status: "missing" };
    },
  },
  {
    id: 31,
    key: "taxTotal",
    name: "Tax Total Amount",
    ublPath: "cac:TaxTotal/cbc:TaxAmount",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      return hasNumber(inv.taxTotal)
        ? { status: "present", value: inv.taxTotal }
        : { status: "missing" };
    },
  },
  {
    id: 32,
    key: "taxTotalAed",
    name: "Tax Total Amount in AED",
    ublPath: "cac:TaxTotal[2]/cbc:TaxAmount",
    category: "tax",
    requirement: "conditional",
    conditionNote: "Required when document currency is not AED",
    evaluate: (inv) => {
      if (!inv.currencyCode || inv.currencyCode === "AED") {
        return {
          status: hasNumber(inv.taxTotalAed) ? "present" : "not_applicable",
          value: inv.taxTotalAed ?? null,
        };
      }
      return hasNumber(inv.taxTotalAed)
        ? { status: "present", value: inv.taxTotalAed }
        : { status: "missing" };
    },
  },
  {
    id: 33,
    key: "taxBreakdown.taxableAmount",
    name: "Tax Subtotal Taxable Amount",
    ublPath: "cac:TaxSubtotal/cbc:TaxableAmount",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const row = firstTax(inv);
      return hasNumber(row?.taxableAmount)
        ? { status: "present", value: row!.taxableAmount }
        : { status: "missing" };
    },
  },
  {
    id: 34,
    key: "taxBreakdown.taxAmount",
    name: "Tax Subtotal Tax Amount",
    ublPath: "cac:TaxSubtotal/cbc:TaxAmount",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const row = firstTax(inv);
      return hasNumber(row?.taxAmount)
        ? { status: "present", value: row!.taxAmount }
        : { status: "missing" };
    },
  },
  {
    id: 35,
    key: "taxBreakdown.taxCategoryCode",
    name: "Tax Category Code",
    ublPath: "cac:TaxCategory/cbc:ID",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const row = firstTax(inv);
      return hasText(row?.taxCategoryCode)
        ? { status: "present", value: row!.taxCategoryCode }
        : { status: "missing" };
    },
  },
  {
    id: 36,
    key: "taxBreakdown.taxPercent",
    name: "Tax Category Percent",
    ublPath: "cac:TaxCategory/cbc:Percent",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const row = firstTax(inv);
      return hasNumber(row?.taxPercent)
        ? { status: "present", value: row!.taxPercent }
        : { status: "missing" };
    },
  },
  {
    id: 37,
    key: "taxScheme",
    name: "Tax Scheme ID",
    ublPath: "cac:TaxScheme/cbc:ID",
    category: "tax",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      return inv.taxBreakdown?.length
        ? { status: "present", value: "VAT", note: "Assumed VAT for UAE supplies" }
        : { status: "missing" };
    },
  },
  {
    id: 38,
    key: "taxBreakdown.exemptionReasonCode",
    name: "Tax Exemption Reason Code",
    ublPath: "cac:TaxCategory/cbc:TaxExemptionReasonCode",
    category: "tax",
    requirement: "conditional",
    conditionNote: "Required for Z / E / O / G categories",
    evaluate: (inv) => {
      const needs = (inv.taxBreakdown ?? []).some((r) =>
        ["Z", "E", "O", "G"].includes(r.taxCategoryCode ?? ""),
      );
      if (!needs) {
        return {
          status: hasText(firstTax(inv)?.exemptionReasonCode) ? "present" : "not_applicable",
        };
      }
      const ok = (inv.taxBreakdown ?? []).every((r) => {
        if (!["Z", "E", "O", "G"].includes(r.taxCategoryCode ?? "")) return true;
        return hasText(r.exemptionReasonCode) || hasText(r.exemptionReason);
      });
      return ok
        ? { status: "present", value: firstTax(inv)?.exemptionReasonCode }
        : { status: "missing" };
    },
  },
  {
    id: 39,
    key: "lineNetTotal",
    name: "Line Extension Amount (document)",
    ublPath: "cac:LegalMonetaryTotal/cbc:LineExtensionAmount",
    category: "totals",
    requirement: "always",
    evaluate: (inv) =>
      hasNumber(inv.lineNetTotal)
        ? { status: "present", value: inv.lineNetTotal }
        : { status: "missing" },
  },
  {
    id: 40,
    key: "taxExclusiveTotal",
    name: "Tax Exclusive Amount",
    ublPath: "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount",
    category: "totals",
    requirement: "always",
    evaluate: (inv) =>
      hasNumber(inv.taxExclusiveTotal)
        ? { status: "present", value: inv.taxExclusiveTotal }
        : { status: "missing" },
  },
  {
    id: 41,
    key: "taxInclusiveTotal",
    name: "Tax Inclusive Amount",
    ublPath: "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    category: "totals",
    requirement: "always",
    evaluate: (inv) =>
      hasNumber(inv.taxInclusiveTotal)
        ? { status: "present", value: inv.taxInclusiveTotal }
        : { status: "missing" },
  },
  {
    id: 42,
    key: "allowanceTotal",
    name: "Allowance Total Amount",
    ublPath: "cac:LegalMonetaryTotal/cbc:AllowanceTotalAmount",
    category: "totals",
    requirement: "conditional",
    conditionNote: "Required when document-level allowances exist",
    evaluate: (inv) =>
      hasNumber(inv.allowanceTotal)
        ? { status: "present", value: inv.allowanceTotal }
        : { status: "missing" },
  },
  {
    id: 43,
    key: "chargeTotal",
    name: "Charge Total Amount",
    ublPath: "cac:LegalMonetaryTotal/cbc:ChargeTotalAmount",
    category: "totals",
    requirement: "conditional",
    conditionNote: "Required when document-level charges exist",
    evaluate: (inv) =>
      hasNumber(inv.chargeTotal)
        ? { status: "present", value: inv.chargeTotal }
        : { status: "missing" },
  },
  {
    id: 44,
    key: "payableAmount",
    name: "Payable Amount",
    ublPath: "cac:LegalMonetaryTotal/cbc:PayableAmount",
    category: "totals",
    requirement: "always",
    evaluate: (inv) =>
      hasNumber(inv.payableAmount)
        ? { status: "present", value: inv.payableAmount }
        : { status: "missing" },
  },
  {
    id: 45,
    key: "lines.id",
    name: "Line ID",
    ublPath: "cac:InvoiceLine/cbc:ID",
    category: "lines",
    requirement: "always",
    evaluate: (inv) => {
      const line = firstLine(inv);
      return hasText(line?.id)
        ? { status: "present", value: line!.id }
        : { status: "missing" };
    },
  },
  {
    id: 46,
    key: "lines.quantity",
    name: "Invoiced Quantity (+ unitCode)",
    ublPath: "cac:InvoiceLine/cbc:InvoicedQuantity",
    category: "lines",
    requirement: "always",
    evaluate: (inv) => {
      const line = firstLine(inv);
      if (!hasNumber(line?.quantity)) return { status: "missing" };
      if (!hasText(line?.unitCode)) {
        return {
          status: "invalid",
          value: line!.quantity,
          note: "Quantity present but unitCode (UN/ECE Rec 20) missing",
        };
      }
      return { status: "present", value: `${line!.quantity} ${line!.unitCode}` };
    },
  },
  {
    id: 47,
    key: "lines.netAmount",
    name: "Line Extension Amount",
    ublPath: "cac:InvoiceLine/cbc:LineExtensionAmount",
    category: "lines",
    requirement: "always",
    evaluate: (inv) => {
      const line = firstLine(inv);
      return hasNumber(line?.netAmount)
        ? { status: "present", value: line!.netAmount }
        : { status: "missing" };
    },
  },
  {
    id: 48,
    key: "lines.name",
    name: "Item Name",
    ublPath: "cac:InvoiceLine/cac:Item/cbc:Name",
    category: "lines",
    requirement: "always",
    evaluate: (inv) => {
      const line = firstLine(inv);
      return hasText(line?.name)
        ? { status: "present", value: line!.name }
        : { status: "missing" };
    },
  },
  {
    id: 49,
    key: "lines.unitPrice",
    name: "Item Net Price",
    ublPath: "cac:InvoiceLine/cac:Price/cbc:PriceAmount",
    category: "lines",
    requirement: "always",
    evaluate: (inv) => {
      const line = firstLine(inv);
      return hasNumber(line?.unitPrice)
        ? { status: "present", value: line!.unitPrice }
        : { status: "missing" };
    },
  },
  {
    id: 50,
    key: "lines.taxCategoryCode",
    name: "Item Tax Category",
    ublPath: "cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID",
    category: "lines",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const line = firstLine(inv);
      return hasText(line?.taxCategoryCode)
        ? { status: "present", value: line!.taxCategoryCode }
        : { status: "missing" };
    },
  },
  {
    id: 51,
    key: "lines.taxPercent",
    name: "Item Tax Rate",
    ublPath: "cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent",
    category: "lines",
    requirement: "tax_doc",
    evaluate: (inv) => {
      if (!isTaxDoc(inv)) return { status: "not_applicable" };
      const line = firstLine(inv);
      return hasNumber(line?.taxPercent)
        ? { status: "present", value: line!.taxPercent }
        : { status: "missing" };
    },
  },
];

if (PINT_AE_FIELDS.length !== 51) {
  throw new Error(`PINT_AE_FIELDS must contain 51 entries, found ${PINT_AE_FIELDS.length}`);
}

export { EXPECTED_CUSTOMIZATION, EXPECTED_PROFILE, sellerEndpoint, buyerEndpoint, partyTaxId };
