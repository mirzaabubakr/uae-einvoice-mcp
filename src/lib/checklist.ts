import { PINT_AE_FIELDS, type FieldStatus } from "./fields.js";
import type { InvoiceDataInput } from "./invoice-types.js";

export interface FieldCheckResult {
  id: number;
  key: string;
  name: string;
  ublPath: string;
  category: string;
  requirement: string;
  conditionNote?: string;
  status: FieldStatus;
  value?: string | number | boolean | null;
  note?: string;
  countsTowardMandatory: boolean;
}

export interface ChecklistResult {
  documentType: string;
  totalFields: 51;
  mandatoryApplicable: number;
  present: number;
  missing: number;
  invalid: number;
  notApplicable: number;
  complete: boolean;
  completionPercent: number;
  summary: string;
  fields: FieldCheckResult[];
  gaps: FieldCheckResult[];
  disclaimer: string;
}

function countsTowardMandatory(
  requirement: string,
  status: FieldStatus,
  isTaxDoc: boolean,
): boolean {
  if (status === "not_applicable") return false;
  if (requirement === "always") return true;
  if (requirement === "tax_doc") return isTaxDoc;
  // Conditional fields that are still applicable (present/missing/invalid)
  return true;
}

export function checkPintAeFields(invoice: InvoiceDataInput): ChecklistResult {
  const documentType = invoice.documentType ?? "tax_invoice";
  const isTaxDoc = documentType === "tax_invoice" || documentType === "credit_note";

  const fields: FieldCheckResult[] = PINT_AE_FIELDS.map((def) => {
    const result = def.evaluate(invoice);
    let status = result.status;

    // Soften conditional "missing" into not_applicable when the condition
    // evaluator already uses missing for "not provided" — for scoring we only
    // treat always + tax_doc (+ conditional when marked missing but needed) as gaps.
    // Conditional fields that evaluate to "missing" without an active condition
    // are treated as not_applicable for completion % except when evaluator
    // returned missing because the condition IS active (tax currency, exemption, etc.).
    if (def.requirement === "conditional" && status === "missing") {
      // Heuristic: if evaluate returned missing with a note saying Must/Required,
      // keep as missing; otherwise treat optional-absent as not_applicable.
      const active =
        Boolean(result.note) ||
        def.key === "taxCurrencyCode" ||
        def.key === "taxTotalAed" ||
        def.key === "taxBreakdown.exemptionReasonCode";
      // For most soft conditionals (due date, trade name, contact, allowance),
      // absence is OK unless business data implies they are needed.
      if (
        !active &&
        [
          "dueDate",
          "buyerReference",
          "periodStart",
          "periodEnd",
          "taxPointDate",
          "seller.tradeName",
          "seller.contact",
          "buyer.tradeName",
          "buyer.contact",
          "allowanceTotal",
          "chargeTotal",
        ].includes(def.key)
      ) {
        status = "not_applicable";
      }
    }

    const mandatory = countsTowardMandatory(def.requirement, status, isTaxDoc);

    return {
      id: def.id,
      key: def.key,
      name: def.name,
      ublPath: def.ublPath,
      category: def.category,
      requirement: def.requirement,
      conditionNote: def.conditionNote,
      status,
      value: result.value,
      note: result.note,
      countsTowardMandatory: mandatory,
    };
  });

  const applicable = fields.filter((f) => f.countsTowardMandatory);
  const present = applicable.filter((f) => f.status === "present").length;
  const missing = applicable.filter((f) => f.status === "missing").length;
  const invalid = applicable.filter((f) => f.status === "invalid").length;
  const notApplicable = fields.filter((f) => f.status === "not_applicable").length;
  const complete = missing === 0 && invalid === 0 && applicable.length > 0;
  const completionPercent =
    applicable.length === 0
      ? 0
      : Math.round((present / applicable.length) * 1000) / 10;

  const gaps = applicable.filter((f) => f.status === "missing" || f.status === "invalid");

  return {
    documentType,
    totalFields: 51,
    mandatoryApplicable: applicable.length,
    present,
    missing,
    invalid,
    notApplicable,
    complete,
    completionPercent,
    summary: complete
      ? `All ${applicable.length} applicable mandatory fields present (${completionPercent}%).`
      : `${gaps.length} gap(s) across ${applicable.length} applicable fields (${completionPercent}% complete).`,
    fields,
    gaps,
    disclaimer:
      "Working model of the 51-field UAE e-invoice matrix for tooling/demo use. Verify against the official MoF mandatory-fields document before production.",
  };
}
