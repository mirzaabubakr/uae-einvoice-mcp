import { randomUUID } from "node:crypto";
import { checkPintAeFields } from "./checklist.js";
import { resolveInvoice, round2, type ResolvedInvoice, type ResolvedLine, type ResolvedParty } from "./derive.js";
import type { AddressInput, InvoiceDataInput, PartyInput, TaxBreakdownInput } from "./invoice-types.js";
import { PAYMENT_MEANS_CODES } from "./codelists.js";

export interface GenerateXmlOptions {
  /** If true, refuse XML when applicable mandatory fields have gaps */
  strict?: boolean;
}

export interface GenerateXmlResult {
  generated: boolean;
  rootElement: "Invoice" | "CreditNote";
  xml: string | null;
  checklistComplete: boolean;
  gaps: Array<{ no?: number; key: string; term: string; name: string; status: string; note?: string }>;
  derived: string[];
  warnings: string[];
  note: string;
}

/** Minimal element tree, rendered in the order given — UBL 2.1 is order-sensitive. */
interface El {
  name: string;
  attrs?: Record<string, string | undefined>;
  text?: string | number;
  children?: Array<El | null | undefined | false>;
}

function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(el: El, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(el.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${esc(v!)}"`)
    .join("");
  const kids = (el.children ?? []).filter((c): c is El => Boolean(c));
  if (kids.length) {
    return `${pad}<${el.name}${attrs}>\n${kids.map((c) => render(c, depth + 1)).join("\n")}\n${pad}</${el.name}>`;
  }
  return `${pad}<${el.name}${attrs}>${el.text === undefined ? "" : esc(el.text)}</${el.name}>`;
}

const cbc = (name: string, text: string | number | undefined | null, attrs?: El["attrs"]): El | null =>
  text === undefined || text === null || text === "" ? null : { name: `cbc:${name}`, text, attrs };
const cac = (name: string, children: El["children"], attrs?: El["attrs"]): El | null =>
  (children ?? []).some(Boolean) ? { name: `cac:${name}`, children, attrs } : null;
const amount = (name: string, value: number | undefined, currency: string): El | null =>
  typeof value === "number" ? cbc(name, round2(value), { currencyID: currency }) : null;

const NO_RATE = new Set(["E", "O"]);
const vatScheme = () => cac("TaxScheme", [cbc("ID", "VAT")]);

function taxCategory(
  wrapper: "TaxCategory" | "ClassifiedTaxCategory",
  code: string | undefined,
  percent: number | undefined,
  exemptionCode?: string,
  exemptionReason?: string,
): El | null {
  const category = code ?? "S";
  return cac(wrapper, [
    cbc("ID", category),
    NO_RATE.has(category) ? null : cbc("Percent", percent ?? 0),
    cbc("TaxExemptionReasonCode", exemptionCode),
    cbc("TaxExemptionReason", exemptionReason),
    vatScheme(),
  ]);
}

function address(a: AddressInput | undefined, subdivision: string | undefined, wrapper = "PostalAddress"): El | null {
  return cac(wrapper, [
    cbc("StreetName", a?.addressLine),
    cbc("CityName", a?.cityOrEmirate),
    cbc("PostalZone", a?.postalZone),
    cbc("CountrySubentity", subdivision),
    cac("Country", [cbc("IdentificationCode", a?.countryCode ?? "AE")]),
  ]);
}

function party(
  wrapper: "AccountingSupplierParty" | "AccountingCustomerParty",
  p: PartyInput | undefined,
  resolved: ResolvedParty,
  isSeller: boolean,
): El | null {
  const trn = p?.trn?.replace(/\D/g, "");
  const tin = p?.tin?.replace(/\D/g, "");
  const agencyName =
    p?.legalRegistrationType === "PAS" ? p.passportIssuingCountry : p?.legalRegistrationAuthority;
  return cac(wrapper, [
    cac("Party", [
      resolved.endpoint
        ? cbc("EndpointID", resolved.endpoint.value.id, { schemeID: resolved.endpoint.value.scheme })
        : null,
      cac("PartyName", [cbc("Name", p?.tradeName)]),
      address(p, resolved.subdivision?.value),
      trn ? cac("PartyTaxScheme", [cbc("CompanyID", trn), vatScheme()]) : null,
      isSeller && !trn && tin
        ? cac("PartyTaxScheme", [cbc("CompanyID", tin), cac("TaxScheme", [cbc("ID", "TIN")])])
        : null,
      cac("PartyLegalEntity", [
        cbc("RegistrationName", p?.legalName ?? ""),
        cbc("CompanyID", p?.legalRegistrationId, {
          schemeAgencyID: p?.legalRegistrationType,
          schemeAgencyName: agencyName,
        }),
      ]),
      cac("Contact", [cbc("Name", p?.contactName), cbc("Telephone", p?.phone), cbc("ElectronicMail", p?.email)]),
    ]),
  ]);
}

function identifiedParty(wrapper: string, id: string | undefined): El | null {
  return id ? cac(wrapper, [cac("Party", [cac("PartyIdentification", [cbc("ID", id)])])]) : null;
}

function taxSubtotal(row: TaxBreakdownInput, currency: string): El | null {
  return cac("TaxSubtotal", [
    amount("TaxableAmount", row.taxableAmount ?? 0, currency),
    amount("TaxAmount", row.taxAmount ?? 0, currency),
    taxCategory("TaxCategory", row.taxCategoryCode, row.taxPercent, row.exemptionReasonCode, row.exemptionReason),
  ]);
}

function invoiceLine(r: ResolvedInvoice, l: ResolvedLine, idx: number): El {
  const line = l.input;
  const currency = r.currency;
  const qtyTag = r.isCreditNote ? "CreditedQuantity" : "InvoicedQuantity";
  const unit = line.unitCode ?? "H87";
  const gross = l.grossPrice?.value;
  const net = line.unitPrice;
  const discount = typeof gross === "number" && typeof net === "number" ? round2(gross - net) : undefined;
  const category = line.taxCategoryCode ?? "S";
  const hasClassification = line.itemType || line.hsCode || line.rcmGoodsType;

  return {
    name: `cac:${r.isCreditNote ? "CreditNoteLine" : "InvoiceLine"}`,
    children: [
      cbc("ID", line.id ?? String(idx + 1)),
      cbc(qtyTag, line.quantity ?? 0, { unitCode: unit }),
      amount("LineExtensionAmount", line.netAmount ?? 0, currency),
      cac("Item", [
        cbc("Description", line.description),
        cbc("Name", line.name ?? ""),
        cac("StandardItemIdentification", [cbc("ID", line.standardItemId, { schemeID: "0160" })]),
        cac("AdditionalItemIdentification", [cbc("ID", line.serviceAccountingCode, { schemeID: "SAC" })]),
        hasClassification
          ? cac("CommodityClassification", [
              cbc("NatureCode", line.rcmGoodsType),
              cbc("CommodityCode", line.itemType),
              cbc("ItemClassificationCode", line.hsCode, { listID: "HS" }),
            ])
          : null,
        taxCategory("ClassifiedTaxCategory", category, line.taxPercent, category === "E" ? line.exemptionReasonCode : undefined),
      ]),
      cac("Price", [
        cbc("PriceAmount", net ?? 0, { currencyID: currency }),
        cbc("BaseQuantity", l.priceBaseQuantity.value, { unitCode: unit }),
        typeof gross === "number"
          ? cac("AllowanceCharge", [
              cbc("ChargeIndicator", "false"),
              cbc("Amount", discount ?? 0, { currencyID: currency }),
              cbc("BaseAmount", gross, { currencyID: currency }),
            ])
          : null,
      ]),
      cac("ItemPriceExtension", [
        amount("Amount", l.lineAmountAed?.value, currency),
        category === "E" ? null : cac("TaxTotal", [amount("TaxAmount", l.vatAmountAed?.value, currency)]),
      ]),
    ],
  };
}

function collectDerived(r: ResolvedInvoice, uuidGenerated: boolean): string[] {
  const out: string[] = [];
  const note = (label: string, res: { derived: boolean; value: unknown; note?: string } | null | undefined) => {
    if (res?.derived) out.push(`${label} = ${JSON.stringify(res.value)}${res.note ? ` (${res.note})` : ""}`);
  };
  if (uuidGenerated) out.push("uuid generated (BTAE-07)");
  note("typeCode", r.typeCode);
  note("customizationId", r.customizationId);
  note("profileId", r.profileId);
  note("transactionType", r.transactionType);
  for (const role of ["seller", "buyer"] as const) {
    note(`${role}.endpoint`, r[role].endpoint);
    note(`${role}.countrySubdivision`, r[role].subdivision);
  }
  for (const l of r.lines) {
    const id = l.input.id ?? l.index + 1;
    note(`line ${id} grossPrice`, l.grossPrice);
    note(`line ${id} priceBaseQuantity`, l.priceBaseQuantity);
    note(`line ${id} vatAmountAed`, l.vatAmountAed);
    note(`line ${id} lineAmountAed`, l.lineAmountAed);
  }
  return out;
}

export function generatePintAeXml(
  invoice: InvoiceDataInput,
  options: GenerateXmlOptions = {},
): GenerateXmlResult {
  const r = resolveInvoice(invoice);
  const checklist = checkPintAeFields(invoice);
  const gaps = checklist.gaps.map((g) => ({
    no: g.no,
    key: g.key,
    term: g.term,
    name: g.name,
    status: g.status,
    note: g.note,
  }));
  const root = r.isCreditNote ? "CreditNote" : "Invoice";
  const warnings: string[] = [];

  if (options.strict && gaps.length > 0) {
    return {
      generated: false,
      rootElement: root,
      xml: null,
      checklistComplete: false,
      gaps,
      derived: [],
      warnings: ["strict=true: XML not generated because applicable mandatory fields are incomplete."],
      note: "Fix the gaps or call again with strict=false to emit a best-effort document.",
    };
  }
  if (gaps.length > 0) {
    warnings.push(`Emitting best-effort XML with ${gaps.length} gap(s). It will not pass PINT AE validation.`);
  }

  const uuid = invoice.uuid ?? randomUUID();
  const currency = r.currency;
  const inv = invoice;
  const isCredit = r.isCreditNote;
  if (isCredit && inv.dueDate && !inv.paymentMeansCode) {
    warnings.push("Credit notes carry the due date in PaymentMeans; dueDate ignored because paymentMeansCode is not set.");
  }

  const header: Array<El | null> = [
    cbc("CustomizationID", r.customizationId.value),
    cbc("ProfileID", r.profileId.value),
    cbc("ProfileExecutionID", r.transactionType?.value),
    cbc("ID", inv.invoiceNumber ?? "UNKNOWN"),
    cbc("UUID", uuid),
    cbc("IssueDate", inv.issueDate ?? ""),
    isCredit ? cbc("TaxPointDate", inv.taxPointDate) : cbc("DueDate", inv.dueDate),
    cbc(isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode", r.typeCode.value),
    isCredit ? null : cbc("TaxPointDate", inv.taxPointDate),
    cbc("DocumentCurrencyCode", currency),
    cbc("TaxCurrencyCode", inv.taxCurrencyCode),
    cbc("BuyerReference", inv.buyerReference),
    cac("InvoicePeriod", [cbc("StartDate", inv.periodStart), cbc("EndDate", inv.periodEnd)]),
    isCredit ? cac("DiscrepancyResponse", [cbc("ResponseCode", inv.creditNoteReasonCode)]) : null,
    cac("BillingReference", [
      cac("InvoiceDocumentReference", [cbc("ID", inv.billingReference), inv.billingReference ? cbc("IssueDate", inv.billingReferenceDate) : null]),
    ]),
    currency !== "AED" && typeof inv.totalWithVatAed === "number"
      ? cac("AdditionalDocumentReference", [
          cbc("ID", "AED"),
          cbc("DocumentTypeCode", "aedtotal-incl-vat"),
          cbc("DocumentDescription", `AED ${round2(inv.totalWithVatAed)}`),
        ])
      : null,
    party("AccountingSupplierParty", inv.seller, r.seller, true),
    party("AccountingCustomerParty", inv.buyer, r.buyer, false),
    identifiedParty("BuyerCustomerParty", inv.beneficiaryId),
    identifiedParty("SellerSupplierParty", inv.principalId),
    inv.deliverTo
      ? cac("Delivery", [cac("DeliveryLocation", [address(inv.deliverTo, inv.deliverTo.countrySubdivision, "Address")])])
      : null,
    inv.paymentMeansCode
      ? cac("PaymentMeans", [
          cbc("PaymentMeansCode", inv.paymentMeansCode, { name: PAYMENT_MEANS_CODES[inv.paymentMeansCode] }),
          isCredit ? cbc("PaymentDueDate", inv.dueDate) : null,
          cac("PayeeFinancialAccount", [cbc("ID", inv.paymentAccountId)]),
        ])
      : null,
    currency !== "AED" && typeof inv.exchangeRate === "number"
      ? cac("TaxExchangeRate", [
          cbc("SourceCurrencyCode", currency),
          cbc("TargetCurrencyCode", inv.taxCurrencyCode ?? "AED"),
          cbc("CalculationRate", inv.exchangeRate),
        ])
      : null,
    {
      name: "cac:TaxTotal",
      children: [
        amount("TaxAmount", inv.taxTotal ?? 0, currency),
        ...(inv.taxBreakdown ?? []).map((row) => taxSubtotal(row, currency)),
      ],
    },
    currency !== "AED" && typeof inv.taxTotalAed === "number"
      ? cac("TaxTotal", [amount("TaxAmount", inv.taxTotalAed, "AED")])
      : null,
    cac("LegalMonetaryTotal", [
      amount("LineExtensionAmount", inv.lineNetTotal ?? 0, currency),
      amount("TaxExclusiveAmount", inv.taxExclusiveTotal ?? 0, currency),
      amount("TaxInclusiveAmount", inv.taxInclusiveTotal ?? 0, currency),
      amount("AllowanceTotalAmount", inv.allowanceTotal, currency),
      amount("ChargeTotalAmount", inv.chargeTotal, currency),
      amount("PrepaidAmount", inv.prepaidAmount, currency),
      amount("PayableAmount", inv.payableAmount ?? 0, currency),
    ]),
  ];

  const doc: El = {
    name: root,
    attrs: {
      xmlns: `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`,
      "xmlns:cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
      "xmlns:cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    },
    children: [...header, ...r.lines.map((l, i) => invoiceLine(r, l, i))],
  };

  return {
    generated: true,
    rootElement: root,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n${render(doc)}\n`,
    checklistComplete: checklist.complete,
    gaps,
    derived: collectDerived(r, !invoice.uuid),
    warnings,
    note: "UBL 2.1 PINT AE document. Run validate_pint_ae_xml (official PINT AE 1.0.4 Schematron) and your ASP's checks before transmission.",
  };
}
