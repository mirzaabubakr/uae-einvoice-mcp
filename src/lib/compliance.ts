import { validateTaxId } from "./trn.js";

export type InvoiceDocumentType = "tax_invoice" | "commercial_invoice" | "credit_note";

export interface PartyInput {
  legalName?: string;
  trn?: string;
  tin?: string;
  countryCode?: string;
  addressLine?: string;
  cityOrEmirate?: string;
  email?: string;
  phone?: string;
  peppolId?: string;
}

export interface InvoiceLineInput {
  id?: string;
  name?: string;
  quantity?: number;
  unitCode?: string;
  netAmount?: number;
  unitPrice?: number;
  taxCategoryCode?: string;
  taxPercent?: number;
}

export interface TaxBreakdownInput {
  taxableAmount?: number;
  taxAmount?: number;
  taxCategoryCode?: string;
  taxPercent?: number;
  exemptionReason?: string;
}

export interface InvoiceDataInput {
  documentType?: InvoiceDocumentType;
  invoiceNumber?: string;
  issueDate?: string;
  currencyCode?: string;
  customizationId?: string;
  profileId?: string;
  typeCode?: string;
  seller?: PartyInput;
  buyer?: PartyInput;
  lineNetTotal?: number;
  taxExclusiveTotal?: number;
  taxTotal?: number;
  taxInclusiveTotal?: number;
  payableAmount?: number;
  taxBreakdown?: TaxBreakdownInput[];
  lines?: InvoiceLineInput[];
}

export type FindingSeverity = "error" | "warning" | "info";

export interface ComplianceFinding {
  code: string;
  severity: FindingSeverity;
  field: string;
  message: string;
}

export interface ComplianceResult {
  compliant: boolean;
  score: number;
  summary: string;
  documentType: InvoiceDocumentType;
  findings: ComplianceFinding[];
  derived: {
    sellerTin: string | null;
    sellerPeppolId: string | null;
    buyerTin: string | null;
    expectedCustomizationId: string;
  };
}

const EXPECTED_CUSTOMIZATION_ID = "urn:peppol:pint:billing-1@ae-1";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAX_CATEGORIES = new Set(["S", "Z", "E", "O", "AE"]);

function add(
  findings: ComplianceFinding[],
  severity: FindingSeverity,
  code: string,
  field: string,
  message: string,
) {
  findings.push({ code, severity, field, message });
}

function resolveTin(party: PartyInput | undefined): {
  tin: string | null;
  findings: ComplianceFinding[];
  prefix: string;
} {
  const findings: ComplianceFinding[] = [];
  const prefix = "party";
  if (!party) return { tin: null, findings, prefix };

  const raw = party.tin ?? party.trn;
  if (!raw) return { tin: null, findings, prefix };

  const result = validateTaxId(raw);
  if (!result.valid) {
    for (const err of result.errors) {
      findings.push({
        code: "TAX_ID_INVALID",
        severity: "error",
        field: party.tin ? "tin" : "trn",
        message: err,
      });
    }
  }
  return { tin: result.tin, findings, prefix };
}

function approxEqual(a: number, b: number, epsilon = 0.02): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function checkInvoiceCompliance(invoice: InvoiceDataInput): ComplianceResult {
  const findings: ComplianceFinding[] = [];
  const documentType: InvoiceDocumentType = invoice.documentType ?? "tax_invoice";
  const isTaxDoc = documentType === "tax_invoice" || documentType === "credit_note";

  // --- Document header ---
  if (!invoice.invoiceNumber?.trim()) {
    add(findings, "error", "INV_NUMBER_MISSING", "invoiceNumber", "Invoice number (cbc:ID) is required.");
  }

  if (!invoice.issueDate) {
    add(findings, "error", "ISSUE_DATE_MISSING", "issueDate", "Issue date is required (YYYY-MM-DD).");
  } else if (!ISO_DATE.test(invoice.issueDate)) {
    add(
      findings,
      "error",
      "ISSUE_DATE_FORMAT",
      "issueDate",
      "Issue date must be ISO format YYYY-MM-DD.",
    );
  }

  if (!invoice.currencyCode) {
    add(findings, "error", "CURRENCY_MISSING", "currencyCode", "DocumentCurrencyCode is required.");
  } else if (invoice.currencyCode !== "AED") {
    add(
      findings,
      "warning",
      "CURRENCY_NOT_AED",
      "currencyCode",
      `Currency is ${invoice.currencyCode}; domestic UAE supplies typically use AED.`,
    );
  }

  if (!invoice.customizationId) {
    add(
      findings,
      "warning",
      "CUSTOMIZATION_MISSING",
      "customizationId",
      `Missing CustomizationID; expected ${EXPECTED_CUSTOMIZATION_ID}.`,
    );
  } else if (invoice.customizationId !== EXPECTED_CUSTOMIZATION_ID) {
    add(
      findings,
      "warning",
      "CUSTOMIZATION_UNEXPECTED",
      "customizationId",
      `CustomizationID is "${invoice.customizationId}"; current PINT AE docs commonly use ${EXPECTED_CUSTOMIZATION_ID}.`,
    );
  }

  if (documentType === "credit_note" && invoice.typeCode && invoice.typeCode !== "381") {
    add(
      findings,
      "warning",
      "TYPE_CODE_CREDIT",
      "typeCode",
      "Credit notes commonly use type code 381.",
    );
  }
  if (documentType === "tax_invoice" && invoice.typeCode && invoice.typeCode !== "380") {
    add(
      findings,
      "warning",
      "TYPE_CODE_INVOICE",
      "typeCode",
      "Tax invoices commonly use type code 380.",
    );
  }

  // --- Seller ---
  if (!invoice.seller?.legalName?.trim()) {
    add(findings, "error", "SELLER_NAME", "seller.legalName", "Seller legal name is mandatory.");
  }

  const sellerId = resolveTin(invoice.seller);
  for (const f of sellerId.findings) {
    findings.push({ ...f, field: `seller.${f.field}` });
  }
  if (!invoice.seller?.trn && !invoice.seller?.tin) {
    add(
      findings,
      "error",
      "SELLER_TAX_ID",
      "seller.trn",
      "Seller TRN (15) or TIN (10) is required for PINT AE party tax scheme / endpoint.",
    );
  }

  if (!invoice.seller?.countryCode) {
    add(findings, "warning", "SELLER_COUNTRY", "seller.countryCode", "Seller country code should be present (AE for UAE).");
  } else if (invoice.seller.countryCode !== "AE") {
    add(
      findings,
      "info",
      "SELLER_COUNTRY_FOREIGN",
      "seller.countryCode",
      "Seller country is not AE — confirm cross-border PINT AE rules with your ASP.",
    );
  }

  if (!invoice.seller?.addressLine || !invoice.seller?.cityOrEmirate) {
    add(
      findings,
      "warning",
      "SELLER_ADDRESS",
      "seller.addressLine",
      "Seller registered address (line + city/emirate) is expected.",
    );
  }

  if (sellerId.tin && invoice.seller?.peppolId) {
    const expected = `0235:${sellerId.tin}`;
    const normalized = invoice.seller.peppolId.replace(/^iso6523-actorid-upis::/i, "");
    if (normalized !== expected && normalized !== sellerId.tin) {
      add(
        findings,
        "error",
        "SELLER_PEPPOL_MISMATCH",
        "seller.peppolId",
        `Seller Peppol ID should be ${expected} (scheme 0235 + TIN).`,
      );
    }
  }

  // --- Buyer ---
  if (!invoice.buyer?.legalName?.trim()) {
    add(findings, "error", "BUYER_NAME", "buyer.legalName", "Buyer legal name is mandatory.");
  }

  const buyerId = resolveTin(invoice.buyer);
  for (const f of buyerId.findings) {
    findings.push({ ...f, field: `buyer.${f.field}` });
  }

  if (isTaxDoc && !invoice.buyer?.trn && !invoice.buyer?.tin) {
    add(
      findings,
      "warning",
      "BUYER_TAX_ID",
      "buyer.trn",
      "Buyer TRN/TIN missing — mandatory for B2B UAE tax invoices; optional only for limited B2C carve-outs.",
    );
  }

  // --- Totals ---
  const requiredTotals: Array<keyof InvoiceDataInput> = [
    "taxExclusiveTotal",
    "taxInclusiveTotal",
    "payableAmount",
  ];
  for (const key of requiredTotals) {
    if (typeof invoice[key] !== "number") {
      add(findings, "error", "TOTAL_MISSING", key, `${key} is required.`);
    }
  }

  if (isTaxDoc && typeof invoice.taxTotal !== "number") {
    add(findings, "error", "TAX_TOTAL_MISSING", "taxTotal", "taxTotal is required on tax invoices / credit notes.");
  }

  if (
    typeof invoice.taxExclusiveTotal === "number" &&
    typeof invoice.taxTotal === "number" &&
    typeof invoice.taxInclusiveTotal === "number" &&
    !approxEqual(invoice.taxExclusiveTotal + invoice.taxTotal, invoice.taxInclusiveTotal)
  ) {
    add(
      findings,
      "error",
      "TOTAL_ARITHMETIC",
      "taxInclusiveTotal",
      "taxExclusiveTotal + taxTotal should equal taxInclusiveTotal.",
    );
  }

  // --- Tax breakdown ---
  if (isTaxDoc) {
    if (!invoice.taxBreakdown?.length) {
      add(
        findings,
        "error",
        "TAX_BREAKDOWN_MISSING",
        "taxBreakdown",
        "At least one tax breakdown (TaxSubtotal) is required for tax invoices.",
      );
    } else {
      let breakdownTax = 0;
      for (const [i, row] of invoice.taxBreakdown.entries()) {
        if (typeof row.taxableAmount !== "number" || typeof row.taxAmount !== "number") {
          add(
            findings,
            "error",
            "TAX_BREAKDOWN_AMOUNTS",
            `taxBreakdown[${i}]`,
            "Each tax breakdown needs taxableAmount and taxAmount.",
          );
        } else {
          breakdownTax += row.taxAmount;
        }
        if (!row.taxCategoryCode) {
          add(
            findings,
            "error",
            "TAX_CATEGORY_MISSING",
            `taxBreakdown[${i}].taxCategoryCode`,
            "Tax category code is required (e.g. S, Z, E, O).",
          );
        } else if (!TAX_CATEGORIES.has(row.taxCategoryCode)) {
          add(
            findings,
            "warning",
            "TAX_CATEGORY_UNCOMMON",
            `taxBreakdown[${i}].taxCategoryCode`,
            `Uncommon tax category "${row.taxCategoryCode}" — verify against PINT AE code list.`,
          );
        }
        if (
          (row.taxCategoryCode === "E" || row.taxCategoryCode === "Z") &&
          !row.exemptionReason?.trim() &&
          row.taxCategoryCode === "E"
        ) {
          add(
            findings,
            "warning",
            "EXEMPTION_REASON",
            `taxBreakdown[${i}].exemptionReason`,
            "Exemption reason is usually required for exempt (E) supplies.",
          );
        }
      }
      if (typeof invoice.taxTotal === "number" && !approxEqual(breakdownTax, invoice.taxTotal)) {
        add(
          findings,
          "error",
          "TAX_BREAKDOWN_SUM",
          "taxTotal",
          "Sum of taxBreakdown.taxAmount should equal taxTotal.",
        );
      }
    }
  }

  // --- Lines ---
  if (!invoice.lines?.length) {
    add(findings, "error", "LINES_MISSING", "lines", "At least one invoice line is required.");
  } else {
    let lineSum = 0;
    for (const [i, line] of invoice.lines.entries()) {
      if (!line.id) {
        add(findings, "warning", "LINE_ID", `lines[${i}].id`, "Line identifier is recommended.");
      }
      if (!line.name?.trim()) {
        add(findings, "error", "LINE_NAME", `lines[${i}].name`, "Line item name is required.");
      }
      if (typeof line.quantity !== "number") {
        add(findings, "error", "LINE_QTY", `lines[${i}].quantity`, "Line quantity is required.");
      }
      if (!line.unitCode) {
        add(
          findings,
          "warning",
          "LINE_UOM",
          `lines[${i}].unitCode`,
          "Unit of measure should use UN/ECE Rec 20 codes (e.g. EA, HUR).",
        );
      }
      if (typeof line.netAmount !== "number") {
        add(findings, "error", "LINE_NET", `lines[${i}].netAmount`, "Line net amount is required.");
      } else {
        lineSum += line.netAmount;
      }
    }
    if (typeof invoice.lineNetTotal === "number" && !approxEqual(lineSum, invoice.lineNetTotal)) {
      add(
        findings,
        "error",
        "LINE_SUM",
        "lineNetTotal",
        "Sum of line net amounts should equal lineNetTotal.",
      );
    } else if (
      typeof invoice.taxExclusiveTotal === "number" &&
      typeof invoice.lineNetTotal !== "number" &&
      !approxEqual(lineSum, invoice.taxExclusiveTotal)
    ) {
      add(
        findings,
        "warning",
        "LINE_SUM_VS_TOTAL",
        "taxExclusiveTotal",
        "Sum of line net amounts does not match taxExclusiveTotal.",
      );
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const maxScore = 100;
  const score = Math.max(0, maxScore - errors.length * 12 - warnings.length * 4);
  const compliant = errors.length === 0;

  const summary = compliant
    ? `Structurally OK for a ${documentType.replace("_", " ")} at field-presence level (${warnings.length} warning(s)). Not a substitute for ASP XSD/Schematron validation.`
    : `Not compliant: ${errors.length} error(s), ${warnings.length} warning(s). Fix errors before ASP submission.`;

  return {
    compliant,
    score,
    summary,
    documentType,
    findings,
    derived: {
      sellerTin: sellerId.tin,
      sellerPeppolId: sellerId.tin ? `0235:${sellerId.tin}` : null,
      buyerTin: buyerId.tin,
      expectedCustomizationId: EXPECTED_CUSTOMIZATION_ID,
    },
  };
}
