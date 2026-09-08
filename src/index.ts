#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { checkPintAeFields } from "./lib/checklist.js";
import { checkInvoiceCompliance } from "./lib/compliance.js";
import { getEinvoicingRequirements } from "./lib/requirements.js";
import { makeSampleTin, validateTaxId } from "./lib/trn.js";
import { generatePintAeXml } from "./lib/xml.js";

const partySchema = z
  .object({
    legalName: z.string().optional(),
    tradeName: z.string().optional(),
    trn: z.string().optional(),
    tin: z.string().optional(),
    countryCode: z.string().optional(),
    addressLine: z.string().optional(),
    cityOrEmirate: z.string().optional(),
    postalZone: z.string().optional(),
    contactName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    peppolId: z.string().optional(),
  })
  .optional();

const invoiceDataSchema = z.object({
  documentType: z
    .enum(["tax_invoice", "commercial_invoice", "credit_note"])
    .optional()
    .describe("Defaults to tax_invoice"),
  invoiceNumber: z.string().optional(),
  issueDate: z.string().optional().describe("ISO date YYYY-MM-DD"),
  dueDate: z.string().optional(),
  currencyCode: z.string().optional().describe("Typically AED"),
  taxCurrencyCode: z.string().optional(),
  customizationId: z
    .string()
    .optional()
    .describe("PINT AE CustomizationID, e.g. urn:peppol:pint:billing-1@ae-1"),
  profileId: z.string().optional(),
  typeCode: z.string().optional().describe("380 invoice / 381 credit note"),
  buyerReference: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  taxPointDate: z.string().optional(),
  billingReference: z.string().optional().describe("Original invoice id for credit notes"),
  seller: partySchema,
  buyer: partySchema,
  lineNetTotal: z.number().optional(),
  taxExclusiveTotal: z.number().optional(),
  taxTotal: z.number().optional(),
  taxTotalAed: z.number().optional(),
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
        taxCategoryCode: z.string().optional(),
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
        quantity: z.number().optional(),
        unitCode: z.string().optional(),
        netAmount: z.number().optional(),
        unitPrice: z.number().optional(),
        taxCategoryCode: z.string().optional(),
        taxPercent: z.number().optional(),
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
    version: "0.2.0",
  });

  server.registerTool(
    "lookup_business_trn",
    {
      description:
        "Validate a UAE Tax Registration Number (15-digit TRN) or Tax Identification Number (10-digit TIN): format, UAE country prefix, Peppol AE:TIN check digit, and derived Peppol participant ID (0235:TIN). Does not call the live FTA register.",
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
        "Structural PINT AE / UAE e-invoicing checks (parties, tax IDs, totals arithmetic, tax breakdown, lines). Returns errors, warnings, a score, and derived Peppol IDs. Prefer check_pint_ae_fields for the full 51-field matrix.",
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
        "Evaluate invoice JSON against the 51-field UAE e-invoice / PINT AE mandatory field matrix. Returns per-field present/missing/invalid/not_applicable status, completion %, and gaps.",
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
        "Generate a UBL 2.1 PINT AE-shaped Invoice/CreditNote XML stub from invoice JSON. Runs the 51-field checklist first; with strict=true refuses to emit XML when mandatory applicable fields are incomplete.",
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
    "get_einvoicing_requirements",
    {
      description:
        "Return the UAE e-invoicing mandate timeline, technical baseline (PINT AE / Peppol / ASP), and next actions for a business segment (large, sme, government, or all). Optional annual revenue (AED) auto-selects large vs SME.",
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

  return server;
}

serveStdio(createServer);
