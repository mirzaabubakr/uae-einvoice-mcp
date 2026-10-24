import { checkPintAeFields } from "./checklist.js";
import { PINT_AE_CUSTOMIZATION_ID, TAX_CATEGORY_CODES } from "./codelists.js";
import { resolveInvoice, round2 } from "./derive.js";
import type { InvoiceDataInput, InvoiceDocumentType, PartyInput } from "./invoice-types.js";
import { validateTaxId } from "./trn.js";

export type {
  InvoiceDataInput,
  InvoiceDocumentType,
  InvoiceLineInput,
  PartyInput,
  TaxBreakdownInput,
} from "./invoice-types.js";

export type FindingSeverity = "error" | "warning" | "info";

export interface ComplianceFinding {
  code: string;
  severity: FindingSeverity;
  field: string;
  message: string;
  /** PINT AE Schematron rule enforcing the same constraint, when there is one. */
  rule?: string;
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
    fieldList: "tax_invoice" | "commercial_invoice";
  };
}

/** Rounding tolerance used by the PINT AE arithmetic rules. */
const TOLERANCE = 0.01;
const close = (a: number, b: number) => Math.abs(round2(a) - round2(b)) <= TOLERANCE;
const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));

export function checkInvoiceCompliance(invoice: InvoiceDataInput): ComplianceResult {
  const r = resolveInvoice(invoice);
  const findings: ComplianceFinding[] = [];
  const add = (severity: FindingSeverity, code: string, field: string, message: string, rule?: string) =>
    findings.push({ code, severity, field, message, rule });

  // Field presence and code lists come from the MoF/PINT AE checklist.
  const checklist = checkPintAeFields(invoice);
  for (const gap of checklist.gaps) {
    add(
      "error",
      gap.status === "missing" ? "FIELD_MISSING" : "FIELD_INVALID",
      gap.key,
      `${gap.no ? `#${gap.no} ` : ""}${gap.name} (${gap.term}): ${gap.note ?? gap.status}`,
      gap.rules?.[0],
    );
  }

  const tins: Record<"seller" | "buyer", string | null> = { seller: null, buyer: null };
  for (const role of ["seller", "buyer"] as const) {
    const party: PartyInput | undefined = invoice[role];
    for (const kind of ["trn", "tin"] as const) {
      const raw = party?.[kind];
      if (!raw) continue;
      const res = validateTaxId(raw);
      if (res.kind !== kind && res.kind !== "unknown") {
        add("error", "TAX_ID_KIND", `${role}.${kind}`, `${role}.${kind} looks like a ${res.kind.toUpperCase()}, not a ${kind.toUpperCase()}.`);
      }
      for (const err of res.errors) add("error", "TAX_ID_INVALID", `${role}.${kind}`, err, kind === "trn" ? "ibr-132-ae" : "ibr-148-ae");
      for (const w of res.warnings.filter((w) => w.includes("check digit"))) add("warning", "TIN_CHECK_DIGIT", `${role}.${kind}`, w);
      tins[role] ??= res.tin;
    }
    const trn = party?.trn?.replace(/\D/g, "");
    const tin = party?.tin?.replace(/\D/g, "");
    if (trn && tin && trn.slice(0, 10) !== tin) {
      add("error", "TIN_TRN_MISMATCH", `${role}.tin`, "The TIN must equal the first 10 digits of the TRN.");
    }
    const ep = r[role].endpoint;
    if (ep && !ep.derived && tins[role] && ep.value.scheme === "0235" && ep.value.id !== tins[role] && !ep.value.id.startsWith("9")) {
      add("error", "PEPPOL_ID_MISMATCH", `${role}.peppolId`, `Peppol ID should be 0235:${tins[role]} (scheme 0235 + TIN).`);
    }
  }

  if (r.fieldList === "tax_invoice" && !r.isCreditNote && !invoice.buyer?.trn && (invoice.buyer?.countryCode ?? "AE") === "AE") {
    add("warning", "BUYER_TRN", "buyer.trn", "Buyer TRN is not set — include it whenever the buyer is VAT-registered (VAT Law Art. 59 tax invoice content).");
  }
  if (invoice.currencyCode && invoice.currencyCode !== "AED") {
    add("info", "FOREIGN_CURRENCY", "currencyCode", `Invoice in ${invoice.currencyCode}: AED tax total (IBT-111), AED grand total (BTAE-20) and exchange rate (BTAE-04) are required.`);
  }
  if (invoice.issueDate && invoice.dueDate && invoice.dueDate < invoice.issueDate) {
    add("warning", "DUE_BEFORE_ISSUE", "dueDate", "Payment due date is before the issue date.");
  }
  if (r.fieldList === "tax_invoice" && r.lines.length && r.lines.every((l) => ["E", "O"].includes(l.input.taxCategoryCode ?? ""))) {
    add("error", "TAX_INVOICE_ONLY_EXEMPT", "typeCode", "A 380/381 document cannot contain only exempt (E) or out-of-scope (O) lines; use 480/81.", "ibr-151-ae");
  }
  if (r.fieldList === "commercial_invoice" && r.lines.some((l) => !["E", "O"].includes(l.input.taxCategoryCode ?? ""))) {
    add("warning", "COMMERCIAL_TAXED_LINES", "lines", "Out-of-scope (480/81) documents normally carry only E or O lines — check ibr-122-ae with your ASP.");
  }

  // Line arithmetic (ibr-147-ae, aligned-ibrp-004).
  for (const l of r.lines) {
    const line = l.input;
    const where = `lines[${l.index}]`;
    if (typeof line.quantity === "number" && typeof line.unitPrice === "number" && typeof line.netAmount === "number") {
      const expected = round2((line.quantity * line.unitPrice) / l.priceBaseQuantity.value);
      if (!close(expected, line.netAmount)) {
        add("error", "LINE_NET_ARITHMETIC", `${where}.netAmount`, `quantity × net price / base quantity = ${expected}, but netAmount is ${line.netAmount}.`, "ibr-147-ae");
      }
    }
    if (typeof line.grossPrice === "number" && typeof line.unitPrice === "number" && line.grossPrice < line.unitPrice) {
      add("error", "GROSS_BELOW_NET", `${where}.grossPrice`, "Gross price must be ≥ net price (net = gross − discount).", "aligned-ibrp-004");
    }
    if (line.taxCategoryCode && TAX_CATEGORY_CODES[line.taxCategoryCode] && line.taxCategoryCode === "S" && typeof line.taxPercent === "number" && typeof line.netAmount === "number" && typeof line.vatAmountAed === "number" && r.isAed) {
      const expected = round2((line.netAmount * line.taxPercent) / 100);
      if (!close(expected, line.vatAmountAed)) {
        add("warning", "LINE_VAT_ARITHMETIC", `${where}.vatAmountAed`, `Expected VAT line amount ≈ ${expected}.`);
      }
    }
  }

  // Tax breakdown arithmetic (aligned-ibrp-s-08 / s-09, z/e/o-09).
  const breakdown = invoice.taxBreakdown ?? [];
  breakdown.forEach((row, i) => {
    const where = `taxBreakdown[${i}]`;
    const cat = row.taxCategoryCode;
    if (!cat) return;
    const linesInCat = r.lines.filter(
      (l) => l.input.taxCategoryCode === cat && (cat !== "S" || l.input.taxPercent === row.taxPercent),
    );
    if (linesInCat.length && typeof row.taxableAmount === "number" && !invoice.allowanceTotal && !invoice.chargeTotal) {
      const expected = sum(linesInCat.map((l) => l.input.netAmount ?? 0));
      if (!close(expected, row.taxableAmount)) {
        add("error", "BREAKDOWN_TAXABLE", `${where}.taxableAmount`, `Sum of ${cat} line net amounts is ${expected}, but taxableAmount is ${row.taxableAmount}.`, `aligned-ibrp-${cat.toLowerCase()}-08`);
      }
    }
    if (typeof row.taxableAmount === "number" && typeof row.taxAmount === "number") {
      const rate = cat === "S" || cat === "N" ? (row.taxPercent ?? 0) : 0;
      const expected = cat === "N" ? 0 : round2((row.taxableAmount * rate) / 100);
      if (!close(expected, row.taxAmount)) {
        add("error", "BREAKDOWN_TAX", `${where}.taxAmount`, `taxableAmount × rate = ${expected}, but taxAmount is ${row.taxAmount}.`, `aligned-ibrp-${cat.toLowerCase()}-09`);
      }
    }
  });
  if (typeof invoice.taxTotal === "number" && breakdown.length) {
    const s = sum(breakdown.map((b) => b.taxAmount ?? 0));
    if (!close(s, invoice.taxTotal)) {
      add("error", "TAX_TOTAL_SUM", "taxTotal", `Sum of breakdown tax amounts is ${s}, but taxTotal is ${invoice.taxTotal}.`, "ibr-co-14");
    }
  }

  // Document totals (ibr-co-10, ibr-co-13, ibr-co-15, ibr-co-16).
  const lineSum = sum(r.lines.map((l) => l.input.netAmount ?? 0));
  if (r.lines.length && typeof invoice.lineNetTotal === "number" && !close(lineSum, invoice.lineNetTotal)) {
    add("error", "LINE_SUM", "lineNetTotal", `Sum of line net amounts is ${lineSum}, but lineNetTotal is ${invoice.lineNetTotal}.`, "ibr-co-10");
  }
  if (typeof invoice.lineNetTotal === "number" && typeof invoice.taxExclusiveTotal === "number") {
    const expected = round2(invoice.lineNetTotal - (invoice.allowanceTotal ?? 0) + (invoice.chargeTotal ?? 0));
    if (!close(expected, invoice.taxExclusiveTotal)) {
      add("error", "TAX_EXCLUSIVE_ARITHMETIC", "taxExclusiveTotal", `lineNetTotal − allowances + charges = ${expected}, but taxExclusiveTotal is ${invoice.taxExclusiveTotal}.`, "ibr-co-13");
    }
  }
  if (typeof invoice.taxExclusiveTotal === "number" && typeof invoice.taxTotal === "number" && typeof invoice.taxInclusiveTotal === "number") {
    const expected = round2(invoice.taxExclusiveTotal + invoice.taxTotal);
    if (!close(expected, invoice.taxInclusiveTotal)) {
      add("error", "TAX_INCLUSIVE_ARITHMETIC", "taxInclusiveTotal", `taxExclusiveTotal + taxTotal = ${expected}, but taxInclusiveTotal is ${invoice.taxInclusiveTotal}.`, "ibr-co-15");
    }
  }
  if (typeof invoice.taxInclusiveTotal === "number" && typeof invoice.payableAmount === "number") {
    const expected = round2(invoice.taxInclusiveTotal - (invoice.prepaidAmount ?? 0));
    if (!close(expected, invoice.payableAmount)) {
      add("error", "PAYABLE_ARITHMETIC", "payableAmount", `taxInclusiveTotal − prepaid = ${expected}, but payableAmount is ${invoice.payableAmount}.`, "ibr-co-16");
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const score = Math.max(0, 100 - errors.length * 8 - warnings.length * 3);
  const compliant = errors.length === 0;

  return {
    compliant,
    score,
    summary: compliant
      ? `No errors against the MoF ${r.fieldList === "tax_invoice" ? "Tax Invoice" : "Commercial Invoice"} field list and PINT AE arithmetic (${warnings.length} warning(s)). Validate the generated XML with validate_pint_ae_xml.`
      : `Not compliant: ${errors.length} error(s), ${warnings.length} warning(s). Fix errors before ASP submission.`,
    documentType: r.documentType,
    findings,
    derived: {
      sellerTin: tins.seller,
      sellerPeppolId: r.seller.endpoint ? `${r.seller.endpoint.value.scheme}:${r.seller.endpoint.value.id}` : null,
      buyerTin: tins.buyer,
      expectedCustomizationId: PINT_AE_CUSTOMIZATION_ID,
      fieldList: r.fieldList,
    },
  };
}
