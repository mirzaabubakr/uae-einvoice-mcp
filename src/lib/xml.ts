import {
  EXPECTED_CUSTOMIZATION,
  EXPECTED_PROFILE,
  buyerEndpoint,
  partyTaxId,
  sellerEndpoint,
} from "./fields.js";
import { checkPintAeFields } from "./checklist.js";
import type { InvoiceDataInput, PartyInput } from "./invoice-types.js";

export interface GenerateXmlOptions {
  /** If true, refuse XML when applicable mandatory fields have gaps */
  strict?: boolean;
}

export interface GenerateXmlResult {
  generated: boolean;
  rootElement: "Invoice" | "CreditNote";
  xml: string | null;
  checklistComplete: boolean;
  gaps: Array<{ id: number; key: string; name: string; status: string; note?: string }>;
  warnings: string[];
  note: string;
}

function esc(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amountTag(tag: string, amount: number, currency: string): string {
  return `<${tag} currencyID="${esc(currency)}">${amount.toFixed(2)}</${tag}>`;
}

function partyXml(
  wrapper: "AccountingSupplierParty" | "AccountingCustomerParty",
  party: PartyInput | undefined,
  role: "seller" | "buyer",
  invoice: InvoiceDataInput,
): string {
  const ep =
    role === "seller" ? sellerEndpoint(invoice) : buyerEndpoint(invoice);
  const tax = partyTaxId(party);
  const name = party?.tradeName ?? party?.legalName ?? "";
  const currency = invoice.currencyCode ?? "AED";

  const contactParts: string[] = [];
  if (party?.contactName) contactParts.push(`      <cbc:Name>${esc(party.contactName)}</cbc:Name>`);
  if (party?.phone) contactParts.push(`      <cbc:Telephone>${esc(party.phone)}</cbc:Telephone>`);
  if (party?.email) {
    contactParts.push(`      <cbc:ElectronicMail>${esc(party.email)}</cbc:ElectronicMail>`);
  }

  return `
  <cac:${wrapper}>
    <cac:Party>
${ep ? `      <cbc:EndpointID schemeID="${esc(ep.scheme)}">${esc(ep.value)}</cbc:EndpointID>` : ""}
${name ? `      <cac:PartyName>
        <cbc:Name>${esc(name)}</cbc:Name>
      </cac:PartyName>` : ""}
      <cac:PostalAddress>
${party?.addressLine ? `        <cbc:StreetName>${esc(party.addressLine)}</cbc:StreetName>` : ""}
${party?.cityOrEmirate ? `        <cbc:CityName>${esc(party.cityOrEmirate)}</cbc:CityName>` : ""}
${party?.postalZone ? `        <cbc:PostalZone>${esc(party.postalZone)}</cbc:PostalZone>` : ""}
        <cac:Country>
          <cbc:IdentificationCode>${esc(party?.countryCode ?? "AE")}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
${
  tax.trn || tax.tin
    ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(tax.trn ?? tax.tin!)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : ""
}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(party?.legalName ?? "")}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
${
  contactParts.length
    ? `      <cac:Contact>
${contactParts.join("\n")}
      </cac:Contact>`
    : ""
}
    </cac:Party>
  </cac:${wrapper}>`.replaceAll(`\n\n`, "\n");
}

export function generatePintAeXml(
  invoice: InvoiceDataInput,
  options: GenerateXmlOptions = {},
): GenerateXmlResult {
  const checklist = checkPintAeFields(invoice);
  const gaps = checklist.gaps.map((g) => ({
    id: g.id,
    key: g.key,
    name: g.name,
    status: g.status,
    note: g.note,
  }));
  const warnings: string[] = [];
  const strict = options.strict ?? false;

  if (strict && gaps.length > 0) {
    return {
      generated: false,
      rootElement: invoice.documentType === "credit_note" ? "CreditNote" : "Invoice",
      xml: null,
      checklistComplete: false,
      gaps,
      warnings: [
        "strict=true: XML not generated because applicable mandatory fields are incomplete.",
      ],
      note: "Fix checklist gaps or call again with strict=false to emit a best-effort stub.",
    };
  }

  if (gaps.length > 0) {
    warnings.push(
      `Emitting best-effort XML with ${gaps.length} checklist gap(s). Not ASP-ready.`,
    );
  }

  const isCredit = invoice.documentType === "credit_note";
  const root = isCredit ? "CreditNote" : "Invoice";
  const typeTag = isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode";
  const lineWrapper = isCredit ? "CreditNoteLine" : "InvoiceLine";
  const qtyTag = isCredit ? "CreditedQuantity" : "InvoicedQuantity";
  const currency = invoice.currencyCode ?? "AED";
  const customization = invoice.customizationId ?? EXPECTED_CUSTOMIZATION;
  const profile = invoice.profileId ?? EXPECTED_PROFILE;
  const typeCode =
    invoice.typeCode ?? (isCredit ? "381" : "380");

  if (!invoice.profileId) {
    warnings.push(`Defaulted ProfileID to ${EXPECTED_PROFILE}`);
  }
  if (!invoice.customizationId) {
    warnings.push(`Defaulted CustomizationID to ${EXPECTED_CUSTOMIZATION}`);
  }

  const taxBlocks = (invoice.taxBreakdown ?? [])
    .map((row) => {
      const exemption =
        row.exemptionReasonCode || row.exemptionReason
          ? `${
              row.exemptionReasonCode
                ? `
          <cbc:TaxExemptionReasonCode>${esc(row.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>`
                : ""
            }${
              row.exemptionReason
                ? `
          <cbc:TaxExemptionReason>${esc(row.exemptionReason)}</cbc:TaxExemptionReason>`
                : ""
            }`
          : "";
      return `
    <cac:TaxSubtotal>
      ${amountTag("cbc:TaxableAmount", row.taxableAmount ?? 0, currency)}
      ${amountTag("cbc:TaxAmount", row.taxAmount ?? 0, currency)}
      <cac:TaxCategory>
        <cbc:ID>${esc(row.taxCategoryCode ?? "S")}</cbc:ID>
        <cbc:Percent>${(row.taxPercent ?? 0).toFixed(2)}</cbc:Percent>${exemption}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
    })
    .join("");

  const lines = (invoice.lines ?? [])
    .map((line, idx) => {
      return `
  <cac:${lineWrapper}>
    <cbc:ID>${esc(line.id ?? String(idx + 1))}</cbc:ID>
    <cbc:${qtyTag} unitCode="${esc(line.unitCode ?? "EA")}">${line.quantity ?? 0}</cbc:${qtyTag}>
    ${amountTag("cbc:LineExtensionAmount", line.netAmount ?? 0, currency)}
    <cac:Item>
      <cbc:Name>${esc(line.name ?? "Item")}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${esc(line.taxCategoryCode ?? "S")}</cbc:ID>
        <cbc:Percent>${(line.taxPercent ?? 0).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      ${amountTag("cbc:PriceAmount", line.unitPrice ?? 0, currency)}
    </cac:Price>
  </cac:${lineWrapper}>`;
    })
    .join("");

  const period =
    invoice.periodStart || invoice.periodEnd
      ? `
  <cac:InvoicePeriod>
${invoice.periodStart ? `    <cbc:StartDate>${esc(invoice.periodStart)}</cbc:StartDate>` : ""}
${invoice.periodEnd ? `    <cbc:EndDate>${esc(invoice.periodEnd)}</cbc:EndDate>` : ""}
  </cac:InvoicePeriod>`
      : "";

  const billingRef = invoice.billingReference
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(invoice.billingReference)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${esc(customization)}</cbc:CustomizationID>
  <cbc:ProfileID>${esc(profile)}</cbc:ProfileID>
  <cbc:ID>${esc(invoice.invoiceNumber ?? "UNKNOWN")}</cbc:ID>
  <cbc:IssueDate>${esc(invoice.issueDate ?? "1970-01-01")}</cbc:IssueDate>
${invoice.dueDate ? `  <cbc:DueDate>${esc(invoice.dueDate)}</cbc:DueDate>` : ""}
${invoice.taxPointDate ? `  <cbc:TaxPointDate>${esc(invoice.taxPointDate)}</cbc:TaxPointDate>` : ""}
  <cbc:${typeTag}>${esc(typeCode)}</cbc:${typeTag}>
  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>
${
  invoice.taxCurrencyCode
    ? `  <cbc:TaxCurrencyCode>${esc(invoice.taxCurrencyCode)}</cbc:TaxCurrencyCode>`
    : ""
}
${invoice.buyerReference ? `  <cbc:BuyerReference>${esc(invoice.buyerReference)}</cbc:BuyerReference>` : ""}
${period}${billingRef}
${partyXml("AccountingSupplierParty", invoice.seller, "seller", invoice)}
${partyXml("AccountingCustomerParty", invoice.buyer, "buyer", invoice)}
  <cac:TaxTotal>
    ${amountTag("cbc:TaxAmount", invoice.taxTotal ?? 0, currency)}
${taxBlocks}
  </cac:TaxTotal>
${
  typeof invoice.taxTotalAed === "number" && currency !== "AED"
    ? `  <cac:TaxTotal>
    ${amountTag("cbc:TaxAmount", invoice.taxTotalAed, "AED")}
  </cac:TaxTotal>`
    : ""
}
  <cac:LegalMonetaryTotal>
    ${amountTag("cbc:LineExtensionAmount", invoice.lineNetTotal ?? 0, currency)}
    ${amountTag("cbc:TaxExclusiveAmount", invoice.taxExclusiveTotal ?? 0, currency)}
    ${amountTag("cbc:TaxInclusiveAmount", invoice.taxInclusiveTotal ?? 0, currency)}
${
  typeof invoice.allowanceTotal === "number"
    ? `    ${amountTag("cbc:AllowanceTotalAmount", invoice.allowanceTotal, currency)}`
    : ""
}
${
  typeof invoice.chargeTotal === "number"
    ? `    ${amountTag("cbc:ChargeTotalAmount", invoice.chargeTotal, currency)}`
    : ""
}
${
  typeof invoice.prepaidAmount === "number"
    ? `    ${amountTag("cbc:PrepaidAmount", invoice.prepaidAmount, currency)}`
    : ""
}
    ${amountTag("cbc:PayableAmount", invoice.payableAmount ?? 0, currency)}
  </cac:LegalMonetaryTotal>
${lines}
</${root}>
`;

  return {
    generated: true,
    rootElement: root,
    xml: xml.replace(/\n{3,}/g, "\n\n").trim() + "\n",
    checklistComplete: checklist.complete,
    gaps,
    warnings,
    note: "UBL 2.1 stub shaped for PINT AE demos. Validate with your ASP XSD/Schematron before transmission.",
  };
}
