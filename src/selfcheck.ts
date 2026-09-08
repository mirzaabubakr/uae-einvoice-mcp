import assert from "node:assert/strict";
import { checkInvoiceCompliance } from "./lib/compliance.js";
import { getEinvoicingRequirements } from "./lib/requirements.js";
import { computeTinCheckDigit, makeSampleTin, validateTaxId } from "./lib/trn.js";

const sampleTin = makeSampleTin("23456789");
assert.equal(sampleTin.length, 10);
assert.equal(sampleTin[0], "1");
assert.equal(Number(sampleTin[9]), computeTinCheckDigit(sampleTin.slice(0, 9)));
assert.equal(validateTaxId(sampleTin).valid, true);
assert.equal(validateTaxId(`${sampleTin}12345`).valid, true);
assert.equal(validateTaxId("1234567890").valid, false);

const good = checkInvoiceCompliance({
  documentType: "tax_invoice",
  invoiceNumber: "INV-1001",
  issueDate: "2026-09-08",
  currencyCode: "AED",
  customizationId: "urn:peppol:pint:billing-1@ae-1",
  typeCode: "380",
  seller: {
    legalName: "Acme Trading LLC",
    tin: sampleTin,
    countryCode: "AE",
    addressLine: "Sheikh Zayed Road",
    cityOrEmirate: "Dubai",
    peppolId: `0235:${sampleTin}`,
  },
  buyer: {
    legalName: "Buyer LLC",
    tin: makeSampleTin("87654321"),
    countryCode: "AE",
  },
  lineNetTotal: 1000,
  taxExclusiveTotal: 1000,
  taxTotal: 50,
  taxInclusiveTotal: 1050,
  payableAmount: 1050,
  taxBreakdown: [
    { taxableAmount: 1000, taxAmount: 50, taxCategoryCode: "S", taxPercent: 5 },
  ],
  lines: [
    {
      id: "1",
      name: "Consulting",
      quantity: 10,
      unitCode: "HUR",
      netAmount: 1000,
      unitPrice: 100,
      taxCategoryCode: "S",
      taxPercent: 5,
    },
  ],
});

assert.equal(good.compliant, true, JSON.stringify(good.findings, null, 2));

const bad = checkInvoiceCompliance({ documentType: "tax_invoice" });
assert.equal(bad.compliant, false);
assert.ok(bad.findings.some((f) => f.severity === "error"));

const reqs = getEinvoicingRequirements("all", 60_000_000);
assert.equal(reqs.segment, "large");
assert.ok(reqs.phases.length === 1);

console.log("All self-checks passed.");
console.log("Sample TIN:", sampleTin);
console.log("Compliance score (good invoice):", good.score);
