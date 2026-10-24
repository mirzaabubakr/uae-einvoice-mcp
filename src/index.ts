#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { checkPintAeFields } from "./lib/checklist.js";
import { checkInvoiceCompliance } from "./lib/compliance.js";
import { getEinvoicingRequirements } from "./lib/requirements.js";
import { readXmlInput, validatePintAeXml } from "./lib/schematron.js";
import { checkEinvoicingScope } from "./lib/scope.js";
import { makeSampleTin, validateTaxId } from "./lib/trn.js";
import { generatePintAeXml } from "./lib/xml.js";

const addressFields = {
  addressLine: z.string().optional(),
  cityOrEmirate: z.string().optional(),
  countrySubdivision: z
    .string()
    .optional()
    .describe("AUH, DXB, SHJ, UAQ, FUJ, AJM or RAK for AE; derived from cityOrEmirate when omitted"),
  postalZone: z.string().optional(),
  countryCode: z.string().optional().describe("ISO 3166-1 alpha-2, AE for UAE"),
};

const partySchema = z
  .object({
    legalName: z.string().optional(),
    tradeName: z.string().optional(),
    trn: z.string().optional().describe("15-digit VAT TRN (1XXXXXXXXXXXX03)"),
    tin: z.string().optional().describe("10-digit TIN; Peppol endpoint 0235:TIN"),
    legalRegistrationId: z.string().optional().describe("Trade licence / Emirates ID / passport / cabinet decision number"),
    legalRegistrationType: z.enum(["TL", "EID", "PAS", "CD"]).optional(),
    legalRegistrationAuthority: z.string().optional().describe("Issuing authority, required for TL"),
    passportIssuingCountry: z.string().optional().describe("ISO country, required for PAS"),
    ...addressFields,
    contactName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    peppolId: z.string().optional().describe("Override endpoint, e.g. 0235:1234567890"),
  })
  .optional();

const invoiceDataSchema = z.object({
  documentType: z
    .enum(["tax_invoice", "commercial_invoice", "credit_note"])
    .optional()
    .describe("Defaults to tax_invoice. commercial_invoice = type 480 (out of scope of tax)"),
  invoiceNumber: z.string().optional(),
  uuid: z.string().optional().describe("BTAE-07; generated when omitted"),
  issueDate: z.string().optional().describe("ISO date YYYY-MM-DD"),
  dueDate: z.string().optional(),
  currencyCode: z.string().optional().describe("ISO 4217, typically AED"),
  taxCurrencyCode: z.string().optional().describe("AED when the invoice currency is not AED"),
  exchangeRate: z.number().optional().describe("BTAE-04 invoice currency → AED, max 6 decimals"),
  customizationId: z
    .string()
    .optional()
    .describe("Defaults to urn:peppol:pint:billing-1@ae-1"),
  profileId: z.string().optional().describe("Defaults to urn:peppol:bis:billing"),
  typeCode: z.string().optional().describe("380 tax invoice, 480 out of scope, 381 credit note, 81 credit note for 480"),
  transactionType: z
    .string()
    .optional()
    .describe("BTAE-02, 8 flags of 0/1: FTZ, deemed, margin, summary, continuous, agent, e-commerce, exports"),
  transactionFlags: z
    .object({
      freeTradeZone: z.boolean().optional(),
      deemedSupply: z.boolean().optional(),
      marginScheme: z.boolean().optional(),
      summaryInvoice: z.boolean().optional(),
      continuousSupply: z.boolean().optional(),
      disclosedAgentBilling: z.boolean().optional(),
      ecommerce: z.boolean().optional(),
      exports: z.boolean().optional(),
    })
    .optional()
    .describe("Alternative to transactionType"),
  paymentMeansCode: z.string().optional().describe("UNCL4461: 1, 10, 20, 21, 30, 49, 54, 55, 68"),
  paymentAccountId: z.string().optional().describe("IBAN; required for credit transfer (30)"),
  buyerReference: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  taxPointDate: z.string().optional(),
  billingReference: z.string().optional().describe("Preceding invoice number for credit notes"),
  billingReferenceDate: z.string().optional(),
  creditNoteReasonCode: z
    .string()
    .optional()
    .describe("BTAE-03: DL8.61.1.A–E or VD"),
  beneficiaryId: z.string().optional().describe("BTAE-01, free trade zone flag"),
  principalId: z.string().optional().describe("BTAE-14, disclosed agent billing flag"),
  deliverTo: z.object(addressFields).optional(),
  seller: partySchema,
  buyer: partySchema,
  lineNetTotal: z.number().optional(),
  taxExclusiveTotal: z.number().optional(),
  taxTotal: z.number().optional(),
  taxTotalAed: z.number().optional().describe("IBT-111 VAT total in AED for non-AED invoices"),
  totalWithVatAed: z.number().optional().describe("BTAE-20 grand total in AED for non-AED invoices"),
  taxInclusiveTotal: z.number().optional(),
  allowanceTotal: z.number().optional(),
  chargeTotal: z.number().optional(),
  prepaidAmount: z.number().optional(),
  payableAmount: z.number().optional(),
  taxBreakdown: z
    .array(
      z.object({
        taxableAmount: z.number().optional(),
        taxAmount: z.number().optional(),
        taxCategoryCode: z.string().optional().describe("S, Z, E, O, AE, N"),
        taxPercent: z.number().optional(),
        exemptionReason: z.string().optional(),
        exemptionReasonCode: z.string().optional(),
      }),
    )
    .optional(),
  lines: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional().describe("IBT-154, mandatory"),
        quantity: z.number().optional(),
        unitCode: z.string().optional().describe("UN/ECE Rec 20, e.g. H87, HUR, KGM"),
        netAmount: z.number().optional(),
        unitPrice: z.number().optional().describe("Net price after discount"),
        grossPrice: z.number().optional().describe("Defaults to unitPrice"),
        priceBaseQuantity: z.number().optional().describe("Defaults to 1"),
        taxCategoryCode: z.string().optional(),
        taxPercent: z.number().optional(),
        exemptionReasonCode: z.string().optional().describe("Required on E lines: DL8.46.1–4"),
        vatAmountAed: z.number().optional().describe("BTAE-08; derived for AED invoices"),
        lineAmountAed: z.number().optional().describe("BTAE-10 net + VAT; derived for AED invoices"),
        itemType: z.enum(["G", "S", "B"]).optional(),
        hsCode: z.string().optional(),
        serviceAccountingCode: z.string().optional(),
        rcmGoodsType: z.string().optional().describe("BTAE-09 for reverse-charge lines"),
        standardItemId: z.string().optional().describe("GTIN (scheme 0160) for reverse-charge lines"),
      }),
    )
    .optional(),
});

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer({
    name: "uae-einvoice-mcp",
    version: "0.2.1",
  });

  server.registerTool(
    "lookup_business_trn",
    {
      description:
        "Validate a UAE Tax Registration Number (15-digit TRN, 1…03) or Tax Identification Number (10-digit TIN, 1…): PINT AE format rules, Peppol AE:TIN check digit (warning only), and derived Peppol participant ID (0235:TIN). Does not call the live FTA register.",
      inputSchema: z.object({
        taxId: z
          .string()
          .describe("15-digit TRN or 10-digit TIN (spaces/dashes allowed)"),
      }),
    },
    async ({ taxId }) => {
      const result = validateTaxId(taxId);
      return textResult({
        ...result,
        note: "Local structural validation only. Confirm active registration on EmaraTax / FTA services before production use.",
        exampleValidTinShape: makeSampleTin(),
      });
    },
  );

  server.registerTool(
    "check_invoice_compliance",
    {
      description:
        "UAE e-invoice JSON checks: MoF mandatory field gaps plus PINT AE arithmetic (line net, tax breakdown, totals), tax ID formats and TIN/TRN consistency. Returns errors and warnings with the PINT AE rule ID where one exists.",
      inputSchema: z.object({
        invoiceData: invoiceDataSchema,
      }),
    },
    async ({ invoiceData }) => textResult(checkInvoiceCompliance(invoiceData)),
  );

  server.registerTool(
    "check_pint_ae_fields",
    {
      description:
        "Evaluate invoice JSON against the MoF mandatory fields list v1.0 — 51 fields for tax invoices/credit notes (380/381), 49 for commercial invoices (480/81) — plus conditional PINT AE fields (UUID, AED totals, flags, credit note reason…). Per-field status present/derived/missing/invalid/not_applicable with PINT AE term, XML path and rule IDs.",
      inputSchema: z.object({
        invoiceData: invoiceDataSchema,
      }),
    },
    async ({ invoiceData }) => textResult(checkPintAeFields(invoiceData)),
  );

  server.registerTool(
    "generate_pint_ae_xml",
    {
      description:
        "Generate a UBL 2.1 PINT AE Invoice/CreditNote from invoice JSON (UUID, transaction flags, payment means, emirate codes, legal registration, price details, AED line amounts). Runs the MoF field checklist first; with strict=true refuses to emit XML when fields are missing.",
      inputSchema: z.object({
        invoiceData: invoiceDataSchema,
        strict: z
          .boolean()
          .optional()
          .describe("If true, do not generate XML when checklist has gaps (default false)"),
      }),
    },
    async ({ invoiceData, strict }) =>
      textResult(generatePintAeXml(invoiceData, { strict: strict ?? false })),
  );

  server.registerTool(
    "validate_pint_ae_xml",
    {
      description:
        "Validate a UBL Invoice or CreditNote against the official PINT AE 1.0.4 Schematron (shared PINT rules + UAE rules) published by OpenPeppol. Returns failed rule IDs, messages and XPath locations. First call downloads and compiles the rules (~5 s); later calls take milliseconds. Does not perform XSD schema or signature validation.",
      inputSchema: z.object({
        xml: z.string().optional().describe("The XML document text"),
        path: z.string().optional().describe("Path to an XML file (alternative to xml)"),
      }),
    },
    async ({ xml, path }) => textResult(await validatePintAeXml(await readXmlInput(xml, path))),
  );

  server.registerTool(
    "get_einvoicing_requirements",
    {
      description:
        "Return the UAE e-invoicing mandate timeline, excluded transactions (MD 197 of 2026), recent amendments, technical baseline (PINT AE / Peppol / ASP), and next actions. Optional annual revenue (AED) auto-selects large vs SME.",
      inputSchema: z.object({
        businessType: z
          .enum(["large", "sme", "government", "all"])
          .optional()
          .describe("Defaults to all"),
        annualRevenueAed: z
          .number()
          .nonnegative()
          .optional()
          .describe("If set with businessType all/omitted, selects large (≥50M) vs sme"),
      }),
    },
    async ({ businessType, annualRevenueAed }) =>
      textResult(getEinvoicingRequirements(businessType ?? "all", annualRevenueAed)),
  );

  server.registerTool(
    "check_einvoicing_scope",
    {
      description:
        "Decide whether a UAE supply must be e-invoiced: B2B/B2G/B2C, intra-Tax-Group (24-month exclusion from 1 Jan 2027), sovereign government, air passenger/cargo, or VAT-exempt/zero-rated financial services. Returns verdict, dates, and whether voluntary issuance is allowed.",
      inputSchema: z.object({
        transactionKind: z
          .enum([
            "b2b",
            "b2g",
            "b2c",
            "intra_tax_group",
            "sovereign_government",
            "air_passenger",
            "air_cargo",
            "financial_exempt_or_zero",
          ])
          .describe("Supply type to evaluate"),
        annualRevenueAed: z
          .number()
          .nonnegative()
          .optional()
          .describe("Seller annual revenue; selects large (≥50M) vs SME dates"),
        entityType: z.enum(["business", "government"]).optional().describe("Defaults to business"),
        asOf: z.string().optional().describe("ISO date YYYY-MM-DD; defaults to today"),
      }),
    },
    async (input) => textResult(checkEinvoicingScope(input)),
  );

  return server;
}

serveStdio(createServer);
