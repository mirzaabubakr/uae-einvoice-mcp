import { CONDITIONAL_FIELDS, mandatoryFieldsFor, type FieldDef, type FieldStatus } from "./fields.js";
import { resolveInvoice } from "./derive.js";
import type { InvoiceDataInput } from "./invoice-types.js";

export interface FieldCheckResult {
  no?: number;
  key: string;
  term: string;
  name: string;
  group: string;
  cardinality: string;
  ublPath: string;
  rules?: string[];
  status: FieldStatus;
  value?: string | number | boolean | null;
  note?: string;
}

export interface ChecklistResult {
  documentType: string;
  typeCode: string;
  fieldList: "tax_invoice" | "commercial_invoice";
  totalFields: number;
  applicable: number;
  present: number;
  derived: number;
  missing: number;
  invalid: number;
  notApplicable: number;
  complete: boolean;
  completionPercent: number;
  summary: string;
  fields: FieldCheckResult[];
  conditionalFields: FieldCheckResult[];
  gaps: FieldCheckResult[];
  source: string;
  disclaimer: string;
}

function toResult(def: FieldDef & { no?: number }, invoice: ReturnType<typeof resolveInvoice>): FieldCheckResult {
  const res = def.evaluate(invoice);
  return {
    no: def.no,
    key: def.key,
    term: def.term,
    name: def.name,
    group: def.group,
    cardinality: def.cardinality,
    ublPath: def.ublPath,
    rules: def.rules,
    status: res.status,
    value: res.value,
    note: res.note,
  };
}

const isGap = (f: FieldCheckResult) => f.status === "missing" || f.status === "invalid";

export function checkPintAeFields(invoice: InvoiceDataInput): ChecklistResult {
  const r = resolveInvoice(invoice);
  const defs = mandatoryFieldsFor(r);
  const fields = defs.map((d) => toResult(d, r));
  const conditionalFields = CONDITIONAL_FIELDS.map((d) => toResult(d, r)).filter(
    (f) => f.status !== "not_applicable",
  );

  const applicable = fields.filter((f) => f.status !== "not_applicable");
  const count = (s: FieldStatus) => applicable.filter((f) => f.status === s).length;
  const present = count("present");
  const derived = count("derived");
  const gaps = [...fields, ...conditionalFields].filter(isGap);
  const complete = gaps.length === 0 && applicable.length > 0;
  const completionPercent =
    applicable.length === 0 ? 0 : Math.round(((present + derived) / applicable.length) * 1000) / 10;
  const listLabel = r.fieldList === "tax_invoice" ? "Tax Invoice (51 fields)" : "Commercial Invoice (49 fields)";

  return {
    documentType: r.documentType,
    typeCode: r.typeCode.value,
    fieldList: r.fieldList,
    totalFields: defs.length,
    applicable: applicable.length,
    present,
    derived,
    missing: count("missing"),
    invalid: count("invalid"),
    notApplicable: fields.length - applicable.length,
    complete,
    completionPercent,
    summary: complete
      ? `All ${applicable.length} applicable fields of the MoF ${listLabel} list are filled (${derived} derived), and no conditional PINT AE field is missing.`
      : `${gaps.length} gap(s) against the MoF ${listLabel} list and conditional PINT AE fields (${completionPercent}% of applicable list fields filled).`,
    fields,
    conditionalFields,
    gaps,
    source:
      "MoF UAE Electronic Invoice Mandatory Fields v1.0 (23 Feb 2026); PINT AE Billing 1.0.4 business terms and Schematron rule IDs.",
    disclaimer:
      "Field-level check of invoice JSON. 'derived' means generate_pint_ae_xml fills the value from other data. Validate the generated XML with validate_pint_ae_xml and your ASP before transmission.",
  };
}
